import { Plan, PlanStatus } from "@app/schemas";
import { Injectable } from "@nestjs/common";
import { EntityManager, Repository } from "typeorm";

@Injectable()
export class PlanRepo extends Repository<Plan> {
  constructor(manager: EntityManager) {
    super(Plan, manager);
  }

  async updateStatus(plan: Plan, status: PlanStatus) {
    const res = await this.update(
      { id: plan.id, status: plan.status },
      { status },
    );
    if (!res.affected) {
      throw new Error(`Failed to update plan status ${plan.id}`);
    }
    plan.status = status;
  }

  async updateTxHash(plan: Plan, txHash: string) {
    const res = await this.update(
      { id: plan.id },
      { status: PlanStatus.TxCreated, txHash },
    );
    if (!res.affected) {
      throw new Error(`Failed to update plan tx hash ${plan.id}`);
    }
    plan.status = PlanStatus.TxCreated;
    plan.txHash = txHash;
  }
}
