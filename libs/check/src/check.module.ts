import { Module } from "@nestjs/common";
import { CheckService } from "./check.service";
import { CkbTxRepo, PlanRepo } from "./repos";

@Module({
  providers: [CheckService, CkbTxRepo, PlanRepo],
  exports: [CheckService],
})
export class CheckModule {}
