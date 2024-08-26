import { Module } from "@nestjs/common";
import { CkbTxRepo } from "./repos";
import { SendService } from "./send.service";

@Module({
  providers: [SendService, CkbTxRepo],
  exports: [SendService],
})
export class SendModule {}
