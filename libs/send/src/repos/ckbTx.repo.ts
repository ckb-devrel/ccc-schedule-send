import { CkbTx, CkbTxStatus } from "@app/schemas";
import { Injectable } from "@nestjs/common";
import { EntityManager, Repository } from "typeorm";

@Injectable()
export class CkbTxRepo extends Repository<CkbTx> {
  constructor(manager: EntityManager) {
    super(CkbTx, manager);
  }

  async updateStatus(ckbTx: CkbTx, status: CkbTxStatus) {
    const res = await this.update(
      { id: ckbTx.id, status: ckbTx.status },
      { status },
    );
    if (!res.affected) {
      throw new Error(`Failed to update CKB tx status ${ckbTx.id}`);
    }
    ckbTx.status = status;
  }

  findTxByHash(txHash: string): Promise<CkbTx | null> {
    return this.findOneBy({ txHash });
  }
}
