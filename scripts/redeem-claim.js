/* eslint-disable no-console */
/**
 * Amount-attested flow: build, sign, and submit EIP-712 RedemptionClaim for NftRedemption.claimReward
 *
 * Changes vs. flat-reward:
 * - Compute pricingHash binding id32->amount (string "<hex32_no0x>:<amount>" joined with '\n', keccak256).
 * - Compute totalReward from MintGarden metadata price ("Original DAC Price") multiplied by EXCHANGE_RATE.
 * - Include pricingHash and totalReward in the EIP-712 typed data and in claimReward args.
 *
 * NFT id canonicalization:
 *   bytes32(id) = keccak256(lowercase_utf8(id_string))
 *
 * nftSetHash:
 *   join lowercase hex (64 chars, no 0x) of each bytes32 id with '\n', keccak256(bytes(joined))
 *
 * Env:
 * - BASE_MAINNET_RPC_URL: RPC URL for Base (or your testnet/fork)
 * - REDEMPTION_CONTRACT: NftRedemption address
 * - REDEMPTION_TOKEN: (optional) ERC20 reward token address (for decimals lookup)
 * - ATTESTOR_PRIVATE_KEY: private key of oracle signer
 * - CLAIMANT_PRIVATE_KEY: private key of tx sender (payer)
 * - POOL_ID or POOL_ID_TEXT: bytes32 pool id or text (hashed)
 * - PAYOUT_ADDRESS: optional EVM address; defaults to claimant address
 * - NFT_IDS_CSV: comma-separated NFT ids (e.g., nft1...,nft1...)
 * - BLS_PUBKEY_HEX48: 48-byte hex (0x + 96 hex), optional; dummy used if omitted
 *
 * Pricing env:
 * - REWARD_EXCHANGE_RATE: decimal (e.g., "1.15") used to multiply USD
 * - REWARD_TOKEN_DECIMALS: fallback decimals if token not queried (default 6)
 * - MINTGARDEN_BASE: "https://api.mintgarden.io"
 * - IPFS_GATEWAY: "https://ipfs.io/ipfs/"
 */

require("dotenv").config();

const {
  JsonRpcProvider,
  Wallet,
  Contract,
  getAddress,
  keccak256,
  toUtf8Bytes,
  hexlify,
  randomBytes,
  parseUnits,
  TypedDataEncoder,
  verifyTypedData,
} = require("ethers");

// --- Env ---
const RPC_URL = process.env.BASE_MAINNET_RPC_URL || "https://mainnet.base.org";
const REDEMPTION_CONTRACT = process.env.REDEMPTION_CONTRACT; // 0x...
const REWARD_TOKEN = process.env.REDEMPTION_TOKEN || ""; // optional
const REWARD_TREASURY = process.env.REWARD_TREASURY || ""; // optional (address holding tokens / approval)
const ATTESTOR_PK = process.env.ATTESTOR_PRIVATE_KEY;
const CLAIMANT_PK = process.env.CLAIMANT_PRIVATE_KEY;

const POOL_ID_HEX = process.env.POOL_ID || "";
const POOL_ID_TEXT = process.env.POOL_ID_TEXT || "SOLSLOT_POOL_DEV";
const PAYOUT_ADDRESS = process.env.PAYOUT_ADDRESS || "";
const NFT_IDS_CSV = process.env.NFT_IDS_CSV || "nft1examplea,nft1exampleb";
const BLS_PUBKEY_HEX48 = process.env.BLS_PUBKEY_HEX48 || "0x" + "11".repeat(48);

// Pricing
const EXCHANGE_RATE = process.env.REWARD_EXCHANGE_RATE || "1.15"; // multiplies USD
const TOKEN_DECIMALS_ENV = process.env.REWARD_TOKEN_DECIMALS || ""; // fallback if we can't fetch on-chain

// MintGarden + IPFS
const MINTGARDEN_BASE =
  process.env.MINTGARDEN_BASE || "https://api.mintgarden.io";
const IPFS_GATEWAY = process.env.IPFS_GATEWAY || "https://ipfs.io/ipfs/";

// --- ABIs ---
const redemptionAbi = [
  "function nftRedeemed(bytes32) view returns (bool)",
  "function claimReward(bytes32,address,bytes,bytes32,bytes32,uint256,uint256,uint64,bytes32,bytes32[],bytes) external",
  "function attestor() view returns (address)",
];
const erc20Abi = [
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
];

// --- Helpers ---
/** Convert a text NFT id (e.g. 'nft1...') to a canonical bytes32 id. */
function idStringToBytes32(id) {
  const lower = String(id || "")
    .trim()
    .toLowerCase();
  return keccak256(toUtf8Bytes(lower)); // 0x + 64 hex
}

/** Join the lowercase hex (no 0x) of each bytes32 with '\n' and keccak256 (matches contract). */
function hashNftListLowerHexWithNewlines(bytes32List) {
  const joined = bytes32List
    .map((h) => String(h).slice(2).toLowerCase())
    .join("\n");
  return keccak256(toUtf8Bytes(joined));
}

/** If not 0x+64, hash text into bytes32. */
function ensureBytes32Hex(input, label) {
  if (typeof input === "string" && /^0x[0-9a-fA-F]{64}$/.test(input)) {
    return "0x" + input.slice(2).toLowerCase();
  }
  const src = String(input || "").trim();
  const hashed = keccak256(toUtf8Bytes(src));
  console.warn(`[${label}] '${input}' => hashed => ${hashed}`);
  return hashed;
}

function ipfsToHttp(uri) {
  if (!uri) return null;
  if (uri.startsWith("ipfs://"))
    return IPFS_GATEWAY + uri.slice("ipfs://".length);
  return uri;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(url);
      const lib = u.protocol === "https:" ? require("https") : require("http");
      const req = lib.get(
        {
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port,
          path: u.pathname + (u.search || ""),
          headers: { "User-Agent": "redeem-claim-script/1.0" },
        },
        (res) => {
          // Follow redirects
          if (
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            const redirected = new URL(res.headers.location, url).toString();
            res.resume(); // drain
            return fetchJson(redirected).then(resolve, reject);
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            res.resume();
            return reject(new Error(`GET ${url} -> ${res.statusCode}`));
          }
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            try {
              const json = JSON.parse(data);
              resolve(json);
            } catch (e) {
              reject(new Error(`Invalid JSON from ${url}: ${e.message}`));
            }
          });
        }
      );
      req.on("error", reject);
    } catch (e) {
      reject(e);
    }
  });
}

async function fetchMintGardenMetadata(nftId) {
  const url = `${MINTGARDEN_BASE}/nfts/${encodeURIComponent(nftId)}/metadata`;
  const body = await fetchJson(url);
  if (body && typeof body === "object") {
    if (body.metadata && typeof body.metadata === "object")
      return body.metadata;
    const uris = Array.isArray(body.metadata_uris)
      ? body.metadata_uris
      : Array.isArray(body.uris)
      ? body.uris
      : null;
    if (Array.isArray(uris) && uris.length > 0) {
      let lastErr;
      for (const raw of uris) {
        try {
          const u = ipfsToHttp(String(raw));
          if (!u) continue;
          return await fetchJson(u);
        } catch (e) {
          lastErr = e;
        }
      }
      throw new Error(
        `MintGarden metadata_uris exhausted for ${nftId}: ${
          lastErr?.message || lastErr
        }`
      );
    }
  }
  return body;
}

/**
 * Extract "Original DAC Price" from metadata JSON.
 * Heuristics:
 * 1) attributes array entries where trait_type/name contains ["original","dac","price"]
 * 2) top-level keys matching those substrings
 * 3) deep object scan for matching keys
 * Returns a decimal string like "25" or "25.00" or null if not found.
 */
function extractOriginalDacPriceUSD(meta) {
  if (!meta || typeof meta !== "object") return null;

  // 1) attributes arrays
  const attributes = Array.isArray(meta?.attributes)
    ? meta.attributes
    : Array.isArray(meta?.Attributes)
    ? meta.Attributes
    : null;
  if (Array.isArray(attributes)) {
    for (const a of attributes) {
      const key = (a?.trait_type || a?.name || "").toString().toLowerCase();
      if (
        key.includes("original") &&
        key.includes("dac") &&
        key.includes("price")
      ) {
        const v = (a?.value ?? "").toString();
        const m = v.match(/(\d+(\.\d+)?)/);
        if (m) return m[1];
      }
    }
  }

  // 2) top-level keys
  for (const k of Object.keys(meta)) {
    const lower = k.toLowerCase();
    if (
      lower.includes("original") &&
      lower.includes("dac") &&
      lower.includes("price")
    ) {
      const v = String(meta[k]);
      const m = v.match(/(\d+(\.\d+)?)/);
      if (m) return m[1];
    }
  }

  // 3) deep scan
  const stack = [meta];
  while (stack.length) {
    const o = stack.pop();
    if (o && typeof o === "object") {
      for (const [k, v] of Object.entries(o)) {
        const lower = String(k).toLowerCase();
        if (
          lower.includes("original") &&
          lower.includes("dac") &&
          lower.includes("price")
        ) {
          const vs = String(v);
          const m = vs.match(/(\d+(\.\d+)?)/);
          if (m) return m[1];
        }
        if (typeof v === "object") stack.push(v);
      }
    }
  }
  return null;
}

/** Multiply priceUSD by exchangeRate using 6-decimal fixed point, return micro-dollars BigInt (scale 6). */
function priceTimesRateToMicroDollars(priceUSD, exchangeRate) {
  const usdMicro = BigInt(parseUnits(String(priceUSD), 6)); // scale 6
  const rateMicro = BigInt(parseUnits(String(exchangeRate), 6)); // scale 6
  const prod = usdMicro * rateMicro; // scale 12
  const denom = 10n ** 6n;
  // round half-up when dividing by 10^6
  return (prod + denom / 2n) / denom;
}

/** Convert micro-dollars (scale 6) to token base units according to tokenDecimals, with rounding half-up. */
function microDollarsToTokenUnits(microDollars, tokenDecimals) {
  if (tokenDecimals === 6) return microDollars;
  if (tokenDecimals > 6) {
    return microDollars * 10n ** BigInt(tokenDecimals - 6);
  }
  const divisor = 10n ** BigInt(6 - tokenDecimals);
  return (microDollars + divisor / 2n) / divisor;
}

async function main() {
  if (!REDEMPTION_CONTRACT) throw new Error("REDEMPTION_CONTRACT is required");
  if (!ATTESTOR_PK) throw new Error("ATTESTOR_PRIVATE_KEY is required");
  if (!CLAIMANT_PK) throw new Error("CLAIMANT_PRIVATE_KEY is required");

  const provider = new JsonRpcProvider(RPC_URL);
  const network = await provider.getNetwork();
  console.log(
    "Network:",
    network.name || "(unknown)",
    "chainId=",
    String(network.chainId)
  );

  const attestor = new Wallet(ATTESTOR_PK, provider);
  const claimant = new Wallet(CLAIMANT_PK, provider);

  // Token decimals
  let tokenDecimals = Number(TOKEN_DECIMALS_ENV || "0");
  if (!tokenDecimals && REWARD_TOKEN) {
    try {
      const t = new Contract(REWARD_TOKEN, erc20Abi, provider);
      tokenDecimals = Number(await t.decimals());
    } catch {
      // ignore, fallback later
    }
  }
  if (!tokenDecimals) tokenDecimals = 6; // default USDC-like

  // Canonical NFT set
  const nftStrings = NFT_IDS_CSV.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (nftStrings.length === 0) throw new Error("NFT_IDS_CSV is empty");
  let nftIdsBytes32 = nftStrings.map(idStringToBytes32);
  nftIdsBytes32.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const nftSetHash = hashNftListLowerHexWithNewlines(nftIdsBytes32);

  // Price each NFT
  const exchangeRate = EXCHANGE_RATE; // decimal string
  const perNftUnits = []; // { id, id32, units }
  for (let i = 0; i < nftStrings.length; i++) {
    const id = nftStrings[i];
    const id32 = idStringToBytes32(id);

    // Fetch metadata via MintGarden robust metadata endpoint
    const meta = await fetchMintGardenMetadata(id);

    // Extract Original DAC Price
    const priceUSD = extractOriginalDacPriceUSD(meta);
    if (!priceUSD)
      throw new Error(`Original DAC Price not found in metadata for ${id}`);

    // Convert to token units
    const microAfterRate = priceTimesRateToMicroDollars(priceUSD, exchangeRate);
    const tokenUnits = microDollarsToTokenUnits(microAfterRate, tokenDecimals);

    perNftUnits.push({ id, id32, units: tokenUnits });
  }

  // Sort by id32 to match on-chain expectation
  perNftUnits.sort((a, b) => (a.id32 < b.id32 ? -1 : a.id32 > b.id32 ? 1 : 0));

  // pricingHash: join "<hex32_no0x>:<amount>" with '\n', keccak256
  const pricingLines = perNftUnits.map(
    (p) => `${p.id32.slice(2).toLowerCase()}:${p.units.toString()}`
  );
  const pricingHash = keccak256(toUtf8Bytes(pricingLines.join("\n")));
  const totalReward = perNftUnits.reduce((acc, p) => acc + p.units, 0n);

  // Preflight: ensure reward token balance/allowance is sufficient to prevent on-chain revert
  if (REWARD_TOKEN) {
    try {
      const token = new Contract(REWARD_TOKEN, erc20Abi, provider);
      // Common pattern: contract pays out from its own token balance
      const contractBal = await token.balanceOf(REDEMPTION_CONTRACT);
      if (contractBal < totalReward) {
        console.error(
          "[preflight] Insufficient reward token balance on contract."
        );
        console.error(
          `[preflight] ${REDEMPTION_CONTRACT} balance=${contractBal.toString()} required=${totalReward.toString()} (token decimals=${tokenDecimals})`
        );
        if (REWARD_TREASURY) {
          // If using a treasury with allowance to the contract, show its stats for guidance
          try {
            const treasuryBal = await token.balanceOf(REWARD_TREASURY);
            const allowance = await token.allowance(
              REWARD_TREASURY,
              REDEMPTION_CONTRACT
            );
            console.error(
              `[preflight] treasury ${REWARD_TREASURY} balance=${treasuryBal.toString()} allowance->contract=${allowance.toString()}`
            );
            console.error(
              "[preflight] If your contract pulls via transferFrom, increase allowance to at least totalReward; otherwise fund the contract address."
            );
          } catch (e) {
            console.warn(
              "[preflight] Failed to read treasury balance/allowance:",
              e?.message || e
            );
          }
        } else {
          console.error(
            "[preflight] Fund the contract with reward tokens before calling claimReward to avoid 'ERC20: transfer amount exceeds balance'."
          );
          console.error(
            "[preflight] Optionally set REWARD_TREASURY to also check allowance balances."
          );
        }
        throw new Error("Preflight failed: reward token balance insufficient");
      }
    } catch (e) {
      console.warn(
        "[preflight] Reward token balance check skipped (could not complete):",
        e?.message || e
      );
    }
  } else {
    console.warn(
      "[preflight] REDEMPTION_TOKEN not set; skipping reward-balance check. Set REDEMPTION_TOKEN to enable this precheck."
    );
  }

  // Build EIP-712 typed data
  const poolId = POOL_ID_HEX
    ? ensureBytes32Hex(POOL_ID_HEX, "poolId(hex)")
    : ensureBytes32Hex(POOL_ID_TEXT, "poolId(text)");
  const evmAddress = PAYOUT_ADDRESS
    ? getAddress(PAYOUT_ADDRESS)
    : await claimant.getAddress();
  if (!/^0x[0-9a-fA-F]{96}$/.test(BLS_PUBKEY_HEX48)) {
    throw new Error("BLS_PUBKEY_HEX48 must be 48-byte hex (0x + 96 hex chars)");
  }

  const domain = {
    name: "Solslot-Redemption",
    version: "1",
    chainId: Number(network.chainId),
    verifyingContract: REDEMPTION_CONTRACT,
  };
  const types = {
    RedemptionClaim: [
      { name: "poolId", type: "bytes32" },
      { name: "evmAddress", type: "address" },
      { name: "blsPubkey", type: "bytes" },
      { name: "nftSetHash", type: "bytes32" },
      { name: "pricingHash", type: "bytes32" },
      { name: "nftCount", type: "uint256" },
      { name: "totalReward", type: "uint256" },
      { name: "issuedAt", type: "uint64" },
      { name: "nonce", type: "bytes32" },
    ],
  };

  const message = {
    poolId,
    evmAddress,
    blsPubkey: BLS_PUBKEY_HEX48,
    nftSetHash,
    pricingHash,
    nftCount: BigInt(nftIdsBytes32.length),
    totalReward,
    issuedAt: BigInt(Math.floor(Date.now() / 1000)),
    nonce: hexlify(randomBytes(32)),
  };

  // Oracle/attestor signs typed data
  const attestorEoa = await attestor.getAddress();
  console.log("attestor_eoa:", attestorEoa);
  const signature = await attestor.signTypedData(domain, types, message);
  const digest = TypedDataEncoder.hash(domain, types, message);
  console.log("digest:", digest);
  console.log("pricingHash:", pricingHash);
  console.log("totalReward:", totalReward.toString());
  console.log("attestation:", signature);
  const recovered = verifyTypedData(domain, types, message, signature);
  console.log("recovered:", recovered);
  const redemptionView = new Contract(
    REDEMPTION_CONTRACT,
    redemptionAbi,
    provider
  );
  const onchainAttestor = await redemptionView.attestor();
  console.log("onchain_attestor:", onchainAttestor);
  if (recovered.toLowerCase() !== onchainAttestor.toLowerCase()) {
    throw new Error(
      `invalid attestation (precheck): recovered=${recovered}, expected=${onchainAttestor}`
    );
  }

  // Call contract
  const redemption = new Contract(REDEMPTION_CONTRACT, redemptionAbi, claimant);

  // sanity: first NFT redeemed?
  const already = await redemption.nftRedeemed(perNftUnits[0].id32);
  if (already) console.warn("First NFT already redeemed; tx may revert.");

  console.log("Submitting claimReward...");
  const tx = await redemption.claimReward(
    message.poolId,
    message.evmAddress,
    message.blsPubkey,
    message.nftSetHash,
    message.pricingHash,
    message.nftCount,
    message.totalReward,
    message.issuedAt,
    message.nonce,
    nftIdsBytes32,
    signature
  );
  console.log("tx:", tx.hash);
  const rcpt = await tx.wait();
  console.log("✅ confirmed:", rcpt.transactionHash);
}

main().catch((e) => {
  console.error("redeem-claim failed:", e);
  process.exit(1);
});
