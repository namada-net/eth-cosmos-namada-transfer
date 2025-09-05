import { createWalletClient, route } from "@skip-go/client";
import { createWalletClient, custom, parseUnits } from "viem";
import { mainnet } from "viem/chains";

declare global {
  interface Window {
    ethereum?: any;
    keplr?: any;
  }
}

const logEl = document.getElementById("log")!;
const btn1 = document.getElementById("transfer")!;
const amountInput = document.getElementById("amount") as HTMLInputElement;
const tnamInput = document.getElementById("tnam") as HTMLInputElement;

const ETHEREUM_CHAIN_ID = "1";
const ETHEREUM_PROXY_ADDR = "0xfc2d0487a0ae42ae7329a80dc269916a9184cf7c";
const ETHEREUM_ICS20_CONTRACT_ADDR =
  "0xa348CfE719B63151F228e3C30EB424BA5a983012";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

const COSMOS_CHAIN_ID = "cosmoshub-4";
const COSMOS_ETHEREUM_CLIENT = "cosmoshub-0";
const COSMOS_PORT = "transfer";
const COSMOS_TO_NAMADA_CHANNEL = "channel-1485";
const COSMOS_IBC_WETH =
  "ibc/C0B53D3D23827AE38058BED0BDCD554229278AF530A8D265FCF6DFF7C4B2ADFF";

function log(...args: any[]) {
  logEl.textContent += args.join(" ") + "\n";
}

function toWeiStr(amountStr: string): string {
  const [i, f] = amountStr.split(".");
  const int = (i || "0").replace(/^0+/, "") || "0";
  const frac = (f || "").padEnd(18, "0").slice(0, 18);
  return (int + frac).replace(/^0+/, "") || "0";
}

async function getKeplrEvmProvider() {
  if (!window.keplr?.ethereum)
    throw new Error("EVM provider of Keplr not found");
  const eth = window.keplr.ethereum;
  await eth.enable();
  return eth;
}

// Ethereum (EVM)
async function getEthereumAccount() {
  const ethProvider = await getKeplrEvmProvider();
  const accounts = await ethProvider.request({ method: "eth_requestAccounts" });
  return accounts[0];
}

// Cosmos Hub
async function getCosmosAccount() {
  await (window as any).keplr.enable(COSMOS_CHAIN_ID);
  const key = await (window as any).keplr.getKey(COSMOS_CHAIN_ID);
  return key.bech32Address;
}

// ERC20 ABI (approve)
const ERC20_ABI = [
  {
    type: "function",
    name: "approve",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
];

// Eureka transfer
const PROXY_ABI = [
  {
    type: "function",
    name: "transfer",
    inputs: [
      { name: "amount", type: "uint256" },
      {
        name: "transferParams",
        type: "tuple",
        components: [
          { name: "token", type: "address" },
          { name: "recipient", type: "string" },
          { name: "sourceClient", type: "string" },
          { name: "destPort", type: "string" },
          { name: "timeoutTimestamp", type: "uint64" },
          { name: "memo", type: "string" },
        ],
      },
      {
        name: "fees",
        type: "tuple",
        components: [
          { name: "relayFee", type: "uint256" },
          { name: "relayFeeRecipient", type: "address" },
          { name: "quoteExpiry", type: "uint64" },
        ],
      },
    ],
    outputs: [{ type: "uint64" }],
  },
] as const;

async function sendEurekaWithPFM(namadaReceiver: string, amountWei: BigInt) {
  const ethProvider = await getKeplrEvmProvider();
  const account = await getEthereumAccount();
  const cosmosAddr = await getCosmosAccount();

  const client = createWalletClient({
    account,
    chain: mainnet,
    transport: custom(ethProvider),
  });

  // 0. get Cosmos info and the relay fee
  const r = await route({
    sourceAssetChainId: ETHEREUM_CHAIN_ID,
    sourceAssetDenom: WETH,
    destAssetChainId: COSMOS_CHAIN_ID,
    destAssetDenom: COSMOS_IBC_WETH,
    amountIn: String(amountWei),
    smartRelay: true,
    experimentalFeatures: ["eureka"],
  });
  const eurekaTransfer = r.operations?.[0].eurekaTransfer;

  const feeInfo = eurekaTransfer.smartRelayFeeQuote;
  const relayFee = BigInt(feeInfo.feeAmount);
  const relayFeeRecipient = feeInfo.feePaymentAddress;

  const expirationStr = feeInfo.expiration;
  const expirationSec = Math.floor(Date.parse(expirationStr) / 1000);
  const quoteExpiry = BigInt(expirationSec);

  const callbackAddress = eurekaTransfer.toChainCallbackContractAddress;
  const entryContract = eurekaTransfer.toChainEntryContractAddress;

  const receivedAmount = amountWei - relayFee;
  log("Amount to be received:", receivedAmount);

  // 1. approve
  await client.writeContract({
    address: WETH as `0x${string}`,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [ETHEREUM_PROXY_ADDR, amountWei],
    account,
  });

  const nowSec = Math.floor(Date.now() / 1000);
  // IMPORTANT: 12 hours timeout because the Skip relayer will ignore the packet with less than 10 hours timeout
  const timeout = BigInt(nowSec + 43200);

  // 2. Forward memo with CosmWasm contract (Cosmos to Namada)
  const memo = JSON.stringify({
    dest_callback: {
      address: callbackAddress,
    },
    wasm: {
      contract: entryContract,
      msg: {
        action: {
          action: {
            ibc_transfer: {
              ibc_info: {
                memo: "", // should be empty
                receiver: namadaReceiver,
                recover_address: cosmosAddr,
                source_channel: COSMOS_TO_NAMADA_CHANNEL,
              },
            },
          },
          exact_out: false,
          timeout_timestamp: parseInt((timeout * 1_000_000_000n).toString()),
        },
      },
    },
  });

  // 3. transfer
  const txHash = await client.writeContract({
    address: ETHEREUM_PROXY_ADDR,
    abi: PROXY_ABI,
    functionName: "transfer",
    args: [
      receivedAmount,
      {
        token: WETH,
        // Need to sent tokens to the callback address
        recipient: callbackAddress,
        sourceClient: COSMOS_ETHEREUM_CLIENT,
        destPort: COSMOS_PORT,
        timeoutTimestamp: timeout,
        memo,
      },
      {
        relayFee,
        relayFeeRecipient,
        quoteExpiry,
      },
    ],
    account,
  });

  log("EVM tx sent:", txHash);
}

btn1.addEventListener("click", async () => {
  try {
    log("Transferring WETH from Ethereum");

    const amountWei = toWeiStr(amountInput.value.trim());
    const toNamada = tnamInput.value.trim();

    await sendEurekaWithPFM(toNamada, BigInt(amountWei));
  } catch (e: any) {
    log("Transfer error", e.message);
  }
});
