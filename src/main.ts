import {
  assets,
  balances,
  chains,
  createWalletClient,
  executeRoute,
  messages,
  route,
} from "@skip-go/client";
import { SigningStargateClient, coins } from "@cosmjs/stargate";
import { createWalletClient, custom } from "viem";
import { mainnet } from "viem/chains";

declare global {
  interface Window {
    ethereum?: any;
    keplr?: any;
  }
}

const logEl = document.getElementById("log")!;
const btn0 = document.getElementById("query")!;
const btn1 = document.getElementById("step1")!;
const btn2 = document.getElementById("step2")!;
const amountInput = document.getElementById("amount") as HTMLInputElement;
const tnamInput = document.getElementById("tnam") as HTMLInputElement;

const ETHEREUM_CHAIN_ID = "1";
const COSMOS_CHAIN_ID = "cosmoshub-4";
const COSMOS_RPC = "https://cosmoshub-mainnet-rpc.itrocket.net";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const COSMOS_IBC_WETH =
  "ibc/C0B53D3D23827AE38058BED0BDCD554229278AF530A8D265FCF6DFF7C4B2ADFF";
const COSMOS_TO_NAMADA_CHANNEL = "channel-1485";

let cachedDestIbcDenomOnHub: string | undefined;

function log(...args: any[]) {
  logEl.textContent += args.join(" ") + "\n";
}

function toWeiStr(amountStr: string): string {
  const [i, f] = amountStr.split(".");
  const int = (i || "0").replace(/^0+/, "") || "0";
  const frac = (f || "").padEnd(18, "0").slice(0, 18);
  return (int + frac).replace(/^0+/, "") || "0";
}

export async function getEthereumSigner() {
  const provider = await getKeplrEvmProvider();
  const account = await getEvmAddress(provider);

  const client = createWalletClient({
    chain: mainnet,
    account,
    transport: custom(provider),
  });

  return client;
}

async function getCosmosSigner(chainId: string) {
  await window.keplr.enable(chainId);
  return window.keplr.getOfflineSignerAuto(chainId);
}

async function getCosmosAddress(): Promise<string> {
  if (!window.keplr || !window.getOfflineSignerAuto) {
    throw new Error("Need Keplr!!");
  }

  await window.keplr.enable(COSMOS_CHAIN_ID);

  const key = await window.keplr.getKey(COSMOS_CHAIN_ID);
  return key.bech32Address;
}

async function getKeplrEvmProvider() {
  if (!window.keplr?.ethereum)
    throw new Error("EVM provider of Keplr not found");
  const eth = window.keplr.ethereum;
  await eth.enable();
  return eth;
}

async function getEvmAddress(eth: any) {
  const [addr] = await eth.request({ method: "eth_requestAccounts" });
  return addr as `0x${string}`;
}

function encodeBalanceOf(addr: string) {
  const a = addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  return "0x70a08231" + a; // 4bytes + 32bytes
}

export async function getEthereumWeth(): Promise<BigInt> {
  const eth = await getKeplrEvmProvider();
  const addr = await getEvmAddress(eth);
  const data = encodeBalanceOf(addr);
  const res = await eth.request({
    method: "eth_call",
    params: [{ to: WETH, data }, "latest"],
  });
  return BigInt(res);
}

btn0.addEventListener("click", async () => {
  const wethBalance = await getEthereumWeth();

  const cosmosAddr = await getCosmosAddress();
  const cosmosBalance = await getCosmosBalance(cosmosAddr, COSMOS_IBC_WETH);

  log("WETH on Ethereum:", wethBalance);
  log("WETH on Cosmos", cosmosBalance);
});

async function getCosmosBalance(
  address: string,
  ibcDenom: string,
): Promise<BigInt> {
  const res = await balances({
    chains: {
      "cosmoshub-4": {
        address,
        denoms: [ibcDenom],
      },
    },
  });

  const bal =
    (res as any)?.chains?.[COSMOS_CHAIN_ID]?.denoms?.[ibcDenom]?.amount ?? "0";
  return BigInt(bal);
}

async function waitCosmosBalanceIncrease(
  address: string,
  ibcDenom: string,
  prevBalance: BigInt,
  timeoutMs = 600_000,
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const now = await getCosmosBalance(address, ibcDenom);
    if (BigInt(now) > prevBalance) return now;
    log("waiting IBC Eureka transfer completion...");
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error("Timeout waiting for balance increase on Cosmos Hub");
}

async function findCosmosHubDenomForWeth(): Promise<string> {
  const list = await assets({ chainId: COSMOS_CHAIN_ID });
  log("DEBUG:", JSON.stringify(list));

  const match = list.assets.find(
    (a: any) =>
      (a.originChainId === ETHEREUM_CHAIN_ID ||
        a.sourceAssetChainId === ETHEREUM_CHAIN_ID) &&
      (a.originDenom?.toLowerCase?.() === WETH.toLowerCase() ||
        a.sourceAssetDenom?.toLowerCase?.() === WETH.toLowerCase()),
  );

  if (!match) throw new Error("No WETH on Cosmos Hub");
  return match.denom as string;
}

btn1.addEventListener("click", async () => {
  try {
    log("Transferring WETH from Ethereum");

    //const res = await findCosmosHubDenomForWeth();
    //console.log("DEBUG:", res);

    const amountWei = toWeiStr(amountInput.value.trim());
    //const r = await route({
    //  sourceAssetChainId: ETHEREUM_CHAIN_ID,
    //  sourceAssetDenom: WETH,
    //  destAssetChainId: COSMOS_CHAIN_ID,
    //  destAssetDenom: COSMOS_IBC_WETH,
    //  amountIn: amountWei,
    //  smartRelay: true,
    //  experimentalFeatures: ["eureka"],
    //});

    const eth = await getKeplrEvmProvider();
    const evmAddr = await getEvmAddress(eth);
    const cosmosAddr = await getCosmosAddress();

    const m = await messages({
      sourceAssetDenom: WETH,
      sourceAssetChainId: ETHEREUM_CHAIN_ID,
      destAssetChainId: COSMOS_CHAIN_ID,
      destAssetDenom: COSMOS_IBC_WETH,
      amountIn: amountWei,
      amountOut: amountWei,
      operations: [
        {
          eureka_transfer: {
            fromChainId: "1",
            toChainId: "cosmoshub-4",
            supportsMemo: true,
						pfmEnabled: true,
          },
        },
      ],
      chainIdsToAffiliates: {},
      addressList: [evmAddr, cosmosAddr],
      experimentalFeatures: ["eureka"],
      smartRelay: true,
    });
    log("DEBUG:", JSON.stringify(m));
    return;

    const prevBalance = await getCosmosBalance(cosmosAddr, COSMOS_IBC_WETH);

    await executeRoute({
      route: r,
      userAddresses: [
        { chainId: ETHEREUM_CHAIN_ID, address: evmAddr },
        { chainId: COSMOS_CHAIN_ID, address: cosmosAddr },
      ],
      getEvmSigner: async () => getEthereumSigner(),
      getCosmosSigner: async (chainId) => getCosmosSigner(chainId),
    });
    log("Waiting for WETH on Cosmos Hub");

    waitCosmosBalanceIncrease(cosmosAddr, COSMOS_IBC_WETH, prevBalance);
  } catch (e: any) {
    log("Step1 error", e.message);
  }
});

btn2.addEventListener("click", async () => {
  try {
    log("Transferring WETH fron Cosmos Hub to Namada");

    const cosmosSigner = await getCosmosSigner(COSMOS_CHAIN_ID);
    const client = await SigningStargateClient.connectWithSigner(
      COSMOS_RPC,
      cosmosSigner,
    );
    const from = await getCosmosAddress();
    const toNamada = tnamInput.value.trim();
    if (!toNamada) throw new Error("tnam required");
    const amountWei = toWeiStr(amountInput.value.trim());

    const fee = {
      amount: coins(4000, "uatom"),
      gas: "200000",
    };

    const timeoutTs = Date.now() + 20 * 60 * 1000;

    const res = await client.sendIbcTokens(
      from,
      toNamada,
      coins(amountWei, COSMOS_IBC_WETH),
      "transfer",
      COSMOS_TO_NAMADA_CHANNEL,
      undefined,
      timeoutTs,
      fee,
      // add memo for shielding
    );
    log("IBC send result", JSON.stringify(res));
  } catch (e: any) {
    log("Step2 error", e.message);
  }
});
