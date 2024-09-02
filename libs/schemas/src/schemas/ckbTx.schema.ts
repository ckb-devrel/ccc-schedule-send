import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

export enum CkbTxStatus {
  Prepared = "Prepared",
  Sent = "Sent",
  Committed = "Committed",
  Failed = "Failed",
  Confirmed = "Confirmed",
}

@Entity()
export class CkbTx {
  @PrimaryGeneratedColumn("increment")
  id: number;

  @Column({ type: "varchar" })
  @Index()
  txHash: string;

  @Column({ type: "longtext" })
  rawTx: string;

  @Column({ type: "varchar" })
  status: CkbTxStatus;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
