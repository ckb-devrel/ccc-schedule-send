import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

export enum PlanStatus {
  Saved = "Saved",
  TxCreated = "TxCreated",
  Finished = "Finished",
}

@Entity()
export class Plan {
  @PrimaryGeneratedColumn("increment")
  id: number;

  @Column({ type: "varchar" })
  address: string;

  @Column({ type: "text" })
  rawType: string;

  @Column({ type: "varchar" })
  amount: string;

  @Column({ type: "integer" })
  blockNumber: number;

  @Column({ type: "varchar", nullable: true })
  txHash: string | null;

  @Column({ type: "varchar" })
  status: PlanStatus;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
