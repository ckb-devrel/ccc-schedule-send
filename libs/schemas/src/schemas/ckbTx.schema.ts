import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

export enum CkbTxStatus {
  Prepared = "Prepared",
  Sent = "Sent",
  Failed = "Failed",
  Confirmed = "Confirmed",
}

@Entity()
export class CkbTx {
  @PrimaryGeneratedColumn("increment")
  id: number;

  @Column({ type: "text" })
  txHash: string;

  @Column({ type: "text" })
  rawTx: string;

  @Column({ type: "varchar" })
  status: CkbTxStatus;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
