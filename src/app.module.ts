import { CheckModule } from "@app/check";
import { loadConfig } from "@app/commons";
import { SchemasModule } from "@app/schemas";
import { SendModule } from "@app/send";
import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [loadConfig],
    }),
    SchemasModule,
    CheckModule,
    SendModule,
  ],
})
export class AppModule {}
