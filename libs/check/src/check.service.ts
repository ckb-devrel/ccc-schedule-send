import { autoRun, foreachInRepo, withTransaction } from "@app/commons";
import { CkbTxStatus, Plan, PlanStatus } from "@app/schemas";
import { ccc } from "@ckb-ccc/core";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import axios, { Axios } from "axios";
import { EntityManager, Equal, LessThanOrEqual, Or } from "typeorm";
import { CkbTxRepo, PlanRepo } from "./repos";

@Injectable()
export class CheckService {
  private readonly logger = new Logger(CheckService.name);
  private readonly requester: Axios;
  private readonly client: ccc.Client;
  private readonly rootKey: HDKey;
  private readonly pathPrefix: string;
  private readonly feeRate: number;

  constructor(
    configService: ConfigService,
    private readonly entityManager: EntityManager,
    private readonly ckbTxRepo: CkbTxRepo,
    private readonly planRepo: PlanRepo,
  ) {
    const mnemonic = configService.get<string>("server_mnemonic");
    if (!mnemonic) {
      throw Error("Empty mnemonic");
    }
    const feeRate = configService.get<number>("fee_rate");
    if (feeRate === undefined) {
      throw Error("Empty fee rate");
    }
    const checkInterval = configService.get<number>("check.interval");
    if (checkInterval === undefined) {
      throw Error("Empty check interval");
    }
    const ckbRpcUrl = configService.get<string>("check.ckb_rpc_url");

    this.rootKey = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic));
    this.pathPrefix = configService.get<string>("hd_path_prefix") ?? "";
    this.feeRate = feeRate;
    this.client = configService.get<boolean>("is_mainnet")
      ? new ccc.ClientPublicMainnet({ url: ckbRpcUrl })
      : new ccc.ClientPublicTestnet({ url: ckbRpcUrl });

    this.requester = axios.create({
      baseURL: configService.get<string>("check.mempool_rpc_url"),
    });
    autoRun(this.logger, checkInterval, () => this.checkPlans());
  }

  async checkPlans() {
    const { data: blockNumber } =
      await this.requester.get("/blocks/tip/height");
    if (typeof blockNumber !== "number") {
      this.logger.error(`Invalid block number: ${blockNumber}`);
      return;
    }

    await foreachInRepo({
      repo: this.planRepo,
      criteria: {
        blockNumber: LessThanOrEqual(blockNumber),
        status: Or(Equal(PlanStatus.Saved), Equal(PlanStatus.TxCreated)),
      },
      isSerial: true,
      handler: async (plan) => {
        switch (plan.status) {
          case PlanStatus.TxCreated:
            if (!(await this.handleTxCreatedPlan(plan))) {
              return;
            }
          // Fallthrough to recreate failed tx
          case PlanStatus.Saved: {
            if (!(await this.handleSavedPlan(plan))) {
              return;
            }
            break;
          }
          default: {
            throw new Error(`Unknown plan ${plan.id} status ${status}`);
          }
        }
      },
    });
  }

  async handleTxCreatedPlan(plan: Plan): Promise<boolean> {
    if (!plan.txHash) {
      this.logger.error(`Unexpected empty tx hash for plan ${plan.id}`);
      return false;
    }

    const tx = await this.ckbTxRepo.findTxByHash(plan.txHash);
    if (!tx) {
      this.logger.error(`Tx with hash ${plan.txHash} not found`);
      return false;
    }

    if (tx.status === CkbTxStatus.Failed) {
      this.logger.error(`Plan ${plan.id} failed.`);
      await this.planRepo.updateStatus(plan, PlanStatus.Saved);
      await this.client.cache.clear();
      return true;
    } else if (tx.status === CkbTxStatus.Confirmed) {
      this.logger.log(`Plan ${plan.id} finished.`);
      await this.planRepo.updateStatus(plan, PlanStatus.Finished);
      return false;
    } else {
      return false;
    }
  }

  async handleSavedPlan(plan: Plan): Promise<boolean> {
    const key = this.rootKey.derive(`${this.pathPrefix}0`);
    if (!key.privateKey) {
      throw Error("Failed to derive key");
    }
    const signer = new ccc.SignerCkbPrivateKey(this.client, key.privateKey);
    const sendAddress = await signer.getRecommendedAddress();
    const { script: change } = await signer.getRecommendedAddressObj();

    const type = ccc.Script.from(JSON.parse(plan.rawType));

    const tx = ccc.Transaction.from({
      outputs: [
        {
          lock: (await ccc.Address.fromString(plan.address, this.client))
            .script,
          type,
        },
      ],
      outputsData: [ccc.numLeToBytes(plan.amount, 16)],
    });
    await tx.addCellDepsOfKnownScripts(this.client, ccc.KnownScript.XUdt);

    await tx.completeInputsByUdt(signer, type);
    const balanceDiff =
      (await tx.getInputsUdtBalance(signer.client, type)) -
      tx.getOutputsUdtBalance(type);
    if (balanceDiff > ccc.Zero) {
      tx.addOutput(
        {
          lock: change,
          type,
        },
        ccc.numLeToBytes(balanceDiff, 16),
      );
    }
    await tx.completeInputsByCapacity(signer);
    await tx.completeFeeBy(signer, this.feeRate);
    const signedTx = await signer.signTransaction(tx);
    const txHash = signedTx.hash();
    await this.client.cache.markTransactions(signedTx);

    this.logger.log(
      `Sending plan ${plan.id}, from ${sendAddress} amount ${plan.amount} hash ${type.hash()} to ${plan.address}, tx hash ${txHash}`,
    );

    await withTransaction(this.entityManager, undefined, async (manager) => {
      const planRepo = new PlanRepo(manager);
      const ckbTxRepo = new CkbTxRepo(manager);

      const rawTx = tx.stringify();
      await planRepo.updateTxHash(plan, txHash);
      await ckbTxRepo.save({
        txHash,
        rawTx,
        status: CkbTxStatus.Prepared,
      });
    });
    return true;
  }
}
