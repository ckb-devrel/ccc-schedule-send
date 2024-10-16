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
    let sending: Promise<void>[] = [];
    let sent = await this.ckbTxRepo.countBy({ status: CkbTxStatus.Sent });

    try {
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
          if (sending.length + sent >= this.maxPendingTxs) {
            const past = sending;
            sending = [];
            await Promise.all(past);
            sent = await this.ckbTxRepo.countBy({ status: CkbTxStatus.Sent });
            if (sent >= this.maxPendingTxs) {
              throw new Error("Too many transactions");
            }
          }

          const tx = ccc.Transaction.from(JSON.parse(ckbTx.rawTx));
          sending.push(
            this.client
              .sendTransaction(tx, "passthrough")
              .catch(async (e): Promise<boolean> => {
                if (
                  e instanceof ccc.ErrorClientVerification ||
                  e instanceof ccc.ErrorClientRBFRejected
                ) {
                  this.logger.error(
                    `CKB TX ${ckbTx.id} hash ${ckbTx.txHash} failed to pass verification.`,
                    e.message,
                  );
                  await this.ckbTxRepo.updateStatus(ckbTx, CkbTxStatus.Failed);
                  return false;
                }

                if (e instanceof ccc.ErrorClientResolveUnknown) {
                  const previousTx = await this.ckbTxRepo.findTxByHash(
                    e.outPoint.txHash,
                  );
                  if (!previousTx || previousTx.status === CkbTxStatus.Failed) {
                    this.logger.error(
                      `CKB TX ${ckbTx.id} hash ${ckbTx.txHash} failed by using unknown out point. ${e.outPoint.txHash}:${e.outPoint.index.toString()}`,
                    );
                    await this.ckbTxRepo.updateStatus(
                      ckbTx,
                      CkbTxStatus.Failed,
                    );
                    return false;
                  }

                  if (
                    previousTx.status === CkbTxStatus.Prepared ||
                    previousTx.status === CkbTxStatus.Sent
                  ) {
                    this.logger.log(
                      `CKB TX ${ckbTx.id} hash ${ckbTx.txHash} is waiting for ${previousTx.id} hash ${previousTx.txHash}.`,
                    );
                    return false;
                  }

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
                  if (!isDead) {
                    this.logger.log(
                      `CKB TX ${ckbTx.id} hash ${ckbTx.txHash} is waiting for ${previousTx.id} hash ${previousTx.txHash}.`,
                    );
                  } else {
                    this.logger.error(
                      `CKB TX ${ckbTx.id} hash ${ckbTx.txHash} failed by using unknown out point. ${e.outPoint.txHash}:${e.outPoint.index.toString()}`,
                    );
                    await this.ckbTxRepo.updateStatus(
                      ckbTx,
                      CkbTxStatus.Failed,
                    );
                  }
                  return false;
                }

                if (e instanceof ccc.ErrorClientDuplicatedTransaction) {
                  // It has been sent
                  return true;
                } else {
                  throw new Error(
                    `CKB TX ${ckbTx.id} hash ${ckbTx.txHash} failed to send ${e.message}.`,
                  );
                }
              })
              .then(async (res) => {
                if (!res) {
                  return;
                }
                await this.ckbTxRepo.updateStatus(ckbTx, CkbTxStatus.Sent);
                this.logger.log(
                  `CKB TX ${ckbTx.id} hash ${ckbTx.txHash} has been sent`,
                );
              }),
          );
        },
      });
    } finally {
      await Promise.all(sending);
    }
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
