import { autoRun, foreachInRepo } from "@app/commons";
import { CkbTxStatus } from "@app/schemas";
import { ccc } from "@ckb-ccc/core";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Equal, Or } from "typeorm";
import { CkbTxRepo } from "./repos";

@Injectable()
export class SendService {
  private readonly logger = new Logger(SendService.name);
  private readonly client: ccc.Client = new ccc.ClientPublicTestnet();

  constructor(
    configService: ConfigService,
    private readonly ckbTxRepo: CkbTxRepo,
  ) {
    const sendInterval = configService.get<number>("send.interval");
    if (sendInterval === undefined) {
      throw Error("Empty check interval");
    }
    const ckbRpcUrl = configService.get<string>("send.ckb_rpc_url");

    this.client = configService.get<boolean>("is_mainnet")
      ? new ccc.ClientPublicMainnet({ url: ckbRpcUrl })
      : new ccc.ClientPublicTestnet({ url: ckbRpcUrl });

    autoRun(this.logger, sendInterval, () => this.checkTxs());
  }

  async checkTxs() {
    await foreachInRepo({
      repo: this.ckbTxRepo,
      criteria: {
        status: Or(Equal(CkbTxStatus.Prepared), Equal(CkbTxStatus.Sent)),
      },
      order: {
        updatedAt: "asc",
      },
      isSerial: true,
      handler: async (ckbTx) => {
        switch (ckbTx.status) {
          case CkbTxStatus.Prepared: {
            const tx = ccc.Transaction.from(JSON.parse(ckbTx.rawTx));
            await this.client.sendTransaction(tx, "passthrough");
            await this.ckbTxRepo.updateStatus(ckbTx, CkbTxStatus.Sent);
            this.logger.log(
              `CKB TX ${ckbTx.id} hash ${ckbTx.txHash} has been sent`,
            );
            break;
          }
          case CkbTxStatus.Sent: {
            const res = await this.client.getTransaction(ckbTx.txHash);
            if (!res || res.blockNumber === undefined) {
              return;
            }

            if (res.status === "rejected") {
              await this.ckbTxRepo.updateStatus(ckbTx, CkbTxStatus.Failed);
              this.logger.error(
                `CKB TX ${ckbTx.id} hash ${ckbTx.txHash} failed ${res.reason}.`,
              );
              return;
            }

            if (res.status !== "committed") {
              return;
            }

            const tip = await this.client.getTip();
            if (tip - res.blockNumber < 24) {
              return;
            }

            await this.ckbTxRepo.updateStatus(ckbTx, CkbTxStatus.Confirmed);

            this.logger.log(
              `CKB TX ${ckbTx.id} hash ${ckbTx.txHash} confirmed`,
            );
            break;
          }
          default: {
            throw new Error(
              `Unknown CKB TX ${ckbTx.id} status ${ckbTx.status}`,
            );
          }
        }
      },
    });
  }
}
