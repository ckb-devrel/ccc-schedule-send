import { autoRun, foreachInRepo } from "@app/commons";
import { CkbTxStatus } from "@app/schemas";
import { ccc } from "@ckb-ccc/core";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CkbTxRepo } from "./repos";

@Injectable()
export class SendService {
  private readonly logger = new Logger(SendService.name);
  private readonly client: ccc.Client = new ccc.ClientPublicTestnet();
  private readonly maxPendingTxs: number;

  constructor(
    configService: ConfigService,
    private readonly ckbTxRepo: CkbTxRepo,
  ) {
    const sendInterval = configService.get<number>("send.interval");
    if (sendInterval === undefined) {
      throw Error("Empty check interval");
    }
    const maxPendingTxs = configService.get<number>("send.max_pending_txs");
    if (maxPendingTxs === undefined) {
      throw Error("Empty max pending txs");
    }
    const ckbRpcUrl = configService.get<string>("send.ckb_rpc_url");

    this.client = configService.get<boolean>("is_mainnet")
      ? new ccc.ClientPublicMainnet({ url: ckbRpcUrl })
      : new ccc.ClientPublicTestnet({ url: ckbRpcUrl });
    this.maxPendingTxs = maxPendingTxs;

    autoRun(this.logger, sendInterval, () => this.checkTxs());
    autoRun(this.logger, sendInterval, () => this.checkSent());
    autoRun(this.logger, sendInterval, () => this.checkCommitted());
  }

  async checkTxs() {
    await foreachInRepo({
      repo: this.ckbTxRepo,
      criteria: {
        status: CkbTxStatus.Prepared,
      },
      order: {
        createdAt: "asc",
      },
      isSerial: true,
      handler: async (ckbTx) => {
        if (
          (await this.ckbTxRepo.countBy({ status: CkbTxStatus.Sent })) >
          this.maxPendingTxs
        ) {
          throw new Error("Too many transactions");
        }

        const res = await this.client.getTransaction(ckbTx.txHash);
        if (!res || res.status === "sent") {
          const tx = ccc.Transaction.from(JSON.parse(ckbTx.rawTx));
          try {
            await this.client.sendTransaction(tx, "passthrough");
          } catch (e) {
            if (
              e instanceof ccc.ErrorClientVerification ||
              e.message.startsWith("PoolRejectedRBF")
            ) {
              this.logger.error(
                `CKB TX ${ckbTx.id} hash ${ckbTx.txHash} failed to pass verification.`,
                e.message,
              );
              await this.ckbTxRepo.updateStatus(ckbTx, CkbTxStatus.Failed);
              return;
            }

            if (e instanceof ccc.ErrorClientResolveUnknown) {
              const previousTx = await this.ckbTxRepo.findTxByHash(
                e.outPoint.txHash,
              );
              const isDead = await (async () => {
                try {
                  return (
                    (await this.client.getCell(e.outPoint)) &&
                    !(await this.client.getCellLive(e.outPoint, false))
                  );
                } catch (err) {
                  return false;
                }
              })();
              if (previousTx?.status === CkbTxStatus.Sent && !isDead) {
                this.logger.log(
                  `CKB TX ${ckbTx.id} hash ${ckbTx.txHash} is waiting for ${previousTx.id} hash ${previousTx.txHash}.`,
                );
              } else {
                this.logger.error(
                  `CKB TX ${ckbTx.id} hash ${ckbTx.txHash} failed by using unknown out point.`,
                );
                await this.ckbTxRepo.updateStatus(ckbTx, CkbTxStatus.Failed);
              }
              return;
            }

            this.logger.error(
              `CKB TX ${ckbTx.id} hash ${ckbTx.txHash} failed to send ${e.message}.`,
            );
            return;
          }
        }
        await this.ckbTxRepo.updateStatus(ckbTx, CkbTxStatus.Sent);
        this.logger.log(
          `CKB TX ${ckbTx.id} hash ${ckbTx.txHash} has been sent`,
        );
      },
    });
  }

  async checkSent() {
    await foreachInRepo({
      repo: this.ckbTxRepo,
      criteria: {
        status: CkbTxStatus.Sent,
      },
      order: {
        updatedAt: "asc",
      },
      select: {
        id: true,
        txHash: true,
        updatedAt: true,
        status: true,
      },
      handler: async (ckbTx) => {
        const res = await this.client.getTransaction(ckbTx.txHash);
        if (!res || res.status === "sent") {
          if (Date.now() - ckbTx.updatedAt.getTime() >= 120000) {
            this.logger.error(
              `CKB TX ${ckbTx.id} hash ${ckbTx.txHash} rearranged by not found.`,
            );
            await this.ckbTxRepo.updateStatus(ckbTx, CkbTxStatus.Prepared);
          }
          return;
        }

        if (res.blockNumber === undefined) {
          if (Date.now() - ckbTx.updatedAt.getTime() >= 600000) {
            this.logger.error(
              `CKB TX ${ckbTx.id} hash ${ckbTx.txHash} rearranged by not committed`,
            );
            await this.ckbTxRepo.updateStatus(ckbTx, CkbTxStatus.Prepared);
          }
        } else {
          await this.ckbTxRepo.updateStatus(ckbTx, CkbTxStatus.Committed);
          this.logger.log(`CKB TX ${ckbTx.id} hash ${ckbTx.txHash} committed`);
        }
      },
    });
  }

  async checkCommitted() {
    await foreachInRepo({
      repo: this.ckbTxRepo,
      criteria: {
        status: CkbTxStatus.Committed,
      },
      order: {
        updatedAt: "asc",
      },
      select: {
        id: true,
        txHash: true,
        updatedAt: true,
        status: true,
      },
      handler: async (ckbTx) => {
        const res = await this.client.getTransaction(ckbTx.txHash);
        if (!res || res.blockNumber === undefined) {
          this.logger.error(
            `CKB TX ${ckbTx.id} hash ${ckbTx.txHash} rearranged by not found.`,
          );
          await this.ckbTxRepo.updateStatus(ckbTx, CkbTxStatus.Prepared);
          return;
        }

        if (res.status === "rejected") {
          await this.ckbTxRepo.updateStatus(ckbTx, CkbTxStatus.Failed);
          this.logger.error(
            `CKB TX ${ckbTx.id} hash ${ckbTx.txHash} failed ${res.reason}.`,
          );
          return;
        }

        const tip = await this.client.getTip();
        if (tip - res.blockNumber < ccc.numFrom(24)) {
          return;
        }

        await this.ckbTxRepo.updateStatus(ckbTx, CkbTxStatus.Confirmed);

        this.logger.log(`CKB TX ${ckbTx.id} hash ${ckbTx.txHash} confirmed`);
      },
    });
  }
}
