import { CkbTx } from "@app/schemas";
import { Injectable } from "@nestjs/common";
import { EntityManager, Repository } from "typeorm";

@Injectable()
export class CkbTxRepo extends Repository<CkbTx> {
  constructor(manager: EntityManager) {
    super(CkbTx, manager);
  }

  findTxByHash(txHash: string): Promise<CkbTx | null> {
    return this.findOneBy({ txHash });
  }
}
