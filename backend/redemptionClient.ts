/**
 * NftRedemption client helper
 *
 * Build, sign (as oracle/attestor), and submit claims to the on-chain NftRedemption contract.
 *
 * EIP-712 domain:
 *   name:    "Solslot-Redemption"
 *   version: "1"
 *   chainId: <from provider>
 *   verifyingContract: <NftRedemption address>
 *
 * Typed struct (must match the Solidity CLAIM_TYPEHASH):
 *   RedemptionClaim {
 *     bytes32 poolId;
 *     address evmAddress;
 *     bytes   blsPubkey;  // 48-byte compressed G1
 *     bytes32 nftSetHash;
 *     uint256 nftCount;
 *     uint64  issuedAt;
 *     bytes32 nonce;
 *   }
 */

import {
  Contract,
  JsonRpcProvider,
  Provider,
  Signer,
  TypedDataEncoder,
  keccak256,
  toUtf8Bytes,
  hexlify,
  randomBytes,
  isBytesLike,
  getAddress,
  isAddress,
} from "ethers";

export const REDEMPTION_EIP712_NAME = "Solslot-Redemption";
export const REDEMPTION_EIP712_VERSION = "1";

export const RedemptionTypes = {
  RedemptionClaim: [
    { name: "poolId", type: "bytes32" },
    { name: "evmAddress", type: "address" },
    { name: "blsPubkey", type: "bytes" }, // 48-byte compressed G1
    { name: "nftSetHash", type: "bytes32" },
    { name: "nftCount", type: "uint256" },
    { name: "issuedAt", type: "uint64" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export type Hex = `0x${string}`;
export type Bytes32 = Hex; // 0x + 64 hex
export type Address = Hex; // 0x + 40 hex

export interface RedemptionClaim {
  poolId: Bytes32;
  evmAddress: Address;
  blsPubkey: Hex; // 48 bytes as hex
  nftSetHash: Bytes32;
  nftCount: bigint;
  issuedAt: bigint; // unix seconds
  nonce: Bytes32;
}

export interface PreparedClaim {
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: Address;
  };
  types: typeof RedemptionTypes;
  message: RedemptionClaim;
  // args for contract call
  poolId: Bytes32;
  evmAddress: Address;
  blsPubkey: Hex;
  nftSetHash: Bytes32;
  nftCount: bigint;
  issuedAt: bigint;
  nonce: Bytes32;
  nftIds: Bytes32[]; // sorted ascending
}

export interface SignedClaim {
  prepared: PreparedClaim;
  digest: Hex;
  signature: Hex;
  attestor: Address;
}

const NFT_REDEMPTION_ABI = [
  "function claimReward(bytes32 poolId,address evmAddress,bytes blsPubkey,bytes32 nftSetHash,uint256 nftCount,uint64 issuedAt,bytes32 nonce,bytes32[] nftIds,bytes attestation) external",
] as const;

/**
 * High-level client to produce and submit NftRedemption claims.
 *
 * Typical flow:
 *  const client = new RedemptionClient({ provider, redemptionAddress, attestorSigner });
 *  const prepared = await client.buildClaim({ poolId, evmAddress, blsPubkey, nftIds });
 *  const { signature } = await client.signClaim(prepared);
 *  const tx = await client.submitClaim(prepared, signature, txSigner); // txSigner may be the user or a relayer
 */
export class RedemptionClient {
  readonly provider: Provider;
  readonly redemptionAddress: Address;
  readonly attestorSigner?: Signer;

  constructor(params: {
    provider: Provider | JsonRpcProvider;
    redemptionAddress: Address;
    attestorSigner?: Signer; // signer that holds the oracle private key
  }) {
    this.provider = params.provider;
    this.redemptionAddress = toAddress(params.redemptionAddress, "redemptionAddress");
    this.attestorSigner = params.attestorSigner;
  }

  /**
   * Build a PreparedClaim: normalize/sort NFT ids, compute nftSetHash, populate EIP-712 domain & message.
   */
  async buildClaim(params: {
    poolId: Bytes32 | string;
    evmAddress: Address | string;
    blsPubkey: Hex | Uint8Array; // 48-byte compressed hex or bytes
    nftIds: (Bytes32 | string)[];
    issuedAt?: number | bigint; // default: now
    nonce?: Bytes32 | string;   // default: random 32 bytes
  }): Promise<PreparedClaim> {
    const network = await this.provider.getNetwork();
    const chainId = Number(network.chainId);

    const poolId = toBytes32(params.poolId, "poolId");
    const evmAddress = toAddress(params.evmAddress, "evmAddress");
    const blsPubkey = toBls48(params.blsPubkey, "blsPubkey");

    const { sortedIds, nftSetHash } = computeNftSetHashAndSortedIds(params.nftIds);

    const issuedAt =
      params.issuedAt !== undefined
        ? toUint64(params.issuedAt, "issuedAt")
        : toUint64(Math.floor(Date.now() / 1000), "issuedAt");

    const nonce: Bytes32 =
      params.nonce !== undefined ? toBytes32(params.nonce, "nonce") : hexlify(randomBytes(32)) as Bytes32;

    const message: RedemptionClaim = {
      poolId,
      evmAddress,
      blsPubkey,
      nftSetHash,
      nftCount: BigInt(sortedIds.length),
      issuedAt,
      nonce,
    };

    const domain = {
      name: REDEMPTION_EIP712_NAME,
      version: REDEMPTION_EIP712_VERSION,
      chainId,
      verifyingContract: this.redemptionAddress,
    };

    return {
      domain,
      types: RedemptionTypes,
      message,
      poolId,
      evmAddress,
      blsPubkey,
      nftSetHash,
      nftCount: BigInt(sortedIds.length),
      issuedAt,
      nonce,
      nftIds: sortedIds,
    };
  }

  /**
   * Sign the PreparedClaim using the attestor signer (oracle).
   */
  async signClaim(prepared: PreparedClaim): Promise<SignedClaim> {
    if (!this.attestorSigner) {
      throw new Error("attestorSigner is required to sign claims");
    }

    const attestorAddr = await this.attestorSigner.getAddress();

    // ethers v6 signTypedData
    const signature = await this.attestorSigner.signTypedData(
      prepared.domain as any,
      prepared.types as any,
      prepared.message as any
    );

    const digest = TypedDataEncoder.hash(
      prepared.domain as any,
      prepared.types as any,
      prepared.message as any
    ) as Hex;

    return {
      prepared,
      digest,
      signature: signature as Hex,
      attestor: toAddress(attestorAddr, "attestor"),
    };
  }

  /**
   * Submit the claim to the on-chain contract.
   *
   * txSigner signs and pays for the transaction (can be the user or a relayer).
   * Payout is always sent to prepared.evmAddress per contract logic.
   */
  async submitClaim(prepared: PreparedClaim, signature: Hex, txSigner: Signer) {
    const contract = new Contract(this.redemptionAddress, NFT_REDEMPTION_ABI, txSigner);
    const tx = await contract.claimReward(
      prepared.poolId,
      prepared.evmAddress,
      prepared.blsPubkey,
      prepared.nftSetHash,
      prepared.nftCount,
      prepared.issuedAt,
      prepared.nonce,
      prepared.nftIds,
      signature
    );
    return tx;
  }

  /**
   * Convenience: build, sign (with attestor), and submit in one call.
   */
  async buildSignAndSubmit(params: {
    poolId: Bytes32 | string;
    evmAddress: Address | string;
    blsPubkey: Hex | Uint8Array;
    nftIds: (Bytes32 | string)[];
    issuedAt?: number | bigint;
    nonce?: Bytes32 | string;
    txSigner: Signer;
  }) {
    const prepared = await this.buildClaim(params);
    const { signature } = await this.signClaim(prepared);
    return this.submitClaim(prepared, signature, params.txSigner);
  }
}

/**
 * Compute nftSetHash and obtain the sorted bytes32[] nftIds.
 * - Normalizes each id to 0x + 64 hex.
 * - Sorts ascending (string compare) which matches bytes32 ordering.
 * - nftSetHash = keccak256( toUtf8Bytes( join(sortedLowerHexWithout0x, "\n") ) )
 */
export function computeNftSetHashAndSortedIds(
  nftIds: (Bytes32 | string)[]
): { sortedIds: Bytes32[]; nftSetHash: Bytes32 } {
  if (!Array.isArray(nftIds)) throw new Error("nftIds must be an array");

  const normalized: Bytes32[] = nftIds.map((id, i) => toBytes32(id, `nftIds[${i}]`));
  const sorted = [...normalized].sort((a, b) => a.localeCompare(b)); // lexical asc

  const partsNo0x = sorted.map((id) => id.slice(2).toLowerCase()).join("\n");
  const hash = keccak256(toUtf8Bytes(partsNo0x)) as Bytes32;

  return { sortedIds: sorted, nftSetHash: hash };
}

/**
 * Helpers and validators
 */

function has0x(s: string): s is Hex {
  return typeof s === "string" && s.startsWith("0x");
}

function toAddress(v: Address | string, field: string): Address {
  if (typeof v !== "string") throw new Error(`${field} must be a string`);
  if (!isAddress(v)) throw new Error(`${field} is not a valid EVM address: ${v}`);
  return getAddress(v) as Address;
}

function toBytes32(v: Bytes32 | string, field: string): Bytes32 {
  if (typeof v !== "string") throw new Error(`${field} must be a string`);
  const s = v.toLowerCase().trim();
  const hex = has0x(s) ? s : (`0x${s}` as Hex);
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`${field} must be 32 bytes (0x + 64 hex), got: ${v}`);
  }
  return hex as Bytes32;
}

/**
 * BLS G1 compressed pubkey: 48 bytes => 96 hex chars (with 0x prefix)
 */
function toBls48(v: Hex | Uint8Array, field: string): Hex {
  if (typeof v === "string") {
    const s = v.trim();
    if (!/^0x[0-9a-fA-F]{96}$/.test(s)) {
      throw new Error(`${field} must be 48-byte compressed hex (0x + 96 hex), got: ${v}`);
    }
    return s as Hex;
  }
  if (!(v instanceof Uint8Array)) {
    throw new Error(`${field} must be hex string or Uint8Array`);
  }
  if (v.length !== 48) {
    throw new Error(`${field} byte length must be 48, got: ${v.length}`);
  }
  const hex = hexlify(v);
  if (!/^0x[0-9a-fA-F]{96}$/.test(hex)) {
    throw new Error(`${field} hex encoding invalid length`);
  }
  return hex as Hex;
}

function toUint64(v: number | bigint, field: string): bigint {
  let bi: bigint;
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v < 0) throw new Error(`${field} must be a finite, non-negative number`);
    bi = BigInt(Math.floor(v));
  } else if (typeof v === "bigint") {
    bi = v;
  } else {
    throw new Error(`${field} must be a number or bigint`);
  }
  const max = (1n << 64n) - 1n;
  if (bi < 0n || bi > max) throw new Error(`${field} out of uint64 range`);
  return bi;
}

/**
 * Recover the signer of an attestation for verification or testing.
 */
export function recoverAttestor(prepared: PreparedClaim, signature: Hex): Address {
  const digest = TypedDataEncoder.hash(
    prepared.domain as any,
    prepared.types as any,
    prepared.message as any
  ) as Hex;

  // ethers v6 utils ECDSA 'recoverAddress' exists on signature lib via 'ethers.SigningKey' in internal,
  // but the simplest path is to use TypedDataEncoder.recover which isn't exposed.
  // Instead, construct a temporary Contract and verify on-chain, or accept external verification.
  // For completeness, we leave a placeholder here to highlight that verification should
  // be performed either on-chain (callStatic) or using a dedicated ECDSA recovery helper library.
  //
  // If you want local verification in Node, consider importing 'ethers/lib/utils' ECDSA recover
  // from a small helper library or the OpenZeppelin off-chain verifier.
  //
  // This function intentionally throws to prevent misuse without a proper implementation.
  throw new Error(
    "recoverAttestor is not implemented in this helper. Verify on-chain via a dry-run call or use a separate ECDSA recovery utility."
  );
}

/**
 * Example usage:
 *
 *  import { JsonRpcProvider, Wallet } from "ethers";
 *
 *  const provider = new JsonRpcProvider(process.env.BASE_MAINNET_RPC_URL!);
 *  const attestor = new Wallet(process.env.ATTESTOR_PRIVATE_KEY!, provider);
 *  const txSigner = new Wallet(process.env.TX_SENDER_PRIVATE_KEY!, provider);
 *
 *  const client = new RedemptionClient({
 *    provider,
 *    redemptionAddress: "0xYourRedemptionContract",
 *    attestorSigner: attestor,
 *  });
 *
 *  const prepared = await client.buildClaim({
 *    poolId: "0x..." ,            // bytes32 pool id
 *    evmAddress: "0xRecipient...", // gets paid
 *    blsPubkey: "0x...",           // 48-byte compressed BLS pubkey
 *    nftIds: ["0x...","0x..."],    // list of bytes32 NFT ids
 *  });
 *
 *  const { signature } = await client.signClaim(prepared);
 *  const tx = await client.submitClaim(prepared, signature, txSigner);
 *  await tx.wait();
 */
