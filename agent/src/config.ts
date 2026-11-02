import fs from "node:fs";
import path from "node:path";

export interface Deployment {
  network: string;
  root: string;
  stakingContract: string;
  aiValidator: string;
  yieldPool: string;
  vault: string;
  productId: string;
  priceId: string;
  /** Farm reward units (24 decimals) per second per staked NEAR. */
  farmRewardRate: string;
  /** One-off price used for emergency credit top-ups (vault v2). */
  topupPriceId?: string;
}

const FILE = (network: string) => path.resolve(import.meta.dirname, `../deployments/${network}.json`);

export function writeDeployment(d: Deployment): void {
  fs.mkdirSync(path.dirname(FILE(d.network)), { recursive: true });
  fs.writeFileSync(FILE(d.network), JSON.stringify(d, null, 2) + "\n");
}

export function readDeployment(network = process.env.NEAR_NETWORK ?? "testnet"): Deployment {
  return JSON.parse(fs.readFileSync(FILE(network), "utf8"));
}
