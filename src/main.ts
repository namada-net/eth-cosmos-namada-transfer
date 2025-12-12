import { route } from "@skip-go/client";
import { createWalletClient, custom, formatUnits } from "viem";
import { mainnet } from "viem/chains";

declare global {
  interface Window {
    ethereum?: any;
  }
}

// ============================================================================
// DOM Elements
// ============================================================================

const logEl = document.getElementById("log")!;
const statusEl = document.getElementById("status")!;
const errorEl = document.getElementById("error")!;
const connectBtn = document.getElementById("connect-wallet")!;
const walletStatusEl = document.getElementById("wallet-status")!;
const transferBtn = document.getElementById("transfer")!;
const amountInput = document.getElementById("amount") as HTMLInputElement;
const tnamInput = document.getElementById("tnam") as HTMLInputElement;
const cosmosInput = document.getElementById("cosmos") as HTMLInputElement;

// ============================================================================
// Constants
// ============================================================================

const ETHEREUM_CHAIN_ID = "1";
const ETHEREUM_CHAIN_ID_HEX = "0x1";
const ETHEREUM_PROXY_ADDR = "0xfc2d0487a0ae42ae7329a80dc269916a9184cf7c";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

const COSMOS_CHAIN_ID = "cosmoshub-4";
const COSMOS_ETHEREUM_CLIENT = "cosmoshub-0";
const COSMOS_PORT = "transfer";
const COSMOS_TO_NAMADA_CHANNEL = "channel-1317";
const COSMOS_IBC_WETH =
  "ibc/C0B53D3D23827AE38058BED0BDCD554229278AF530A8D265FCF6DFF7C4B2ADFF";

// ============================================================================
// State
// ============================================================================

let connectedAccount: string | null = null;

// ============================================================================
// Logging & Status Utilities
// ============================================================================

function log(...args: any[]) {
  const timestamp = new Date().toLocaleTimeString();
  logEl.textContent += `[${timestamp}] ${args.join(" ")}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(message: string, type: "info" | "success" | "warning" = "info") {
  statusEl.textContent = message;
  statusEl.className = `status status-${type}`;
}

function clearStatus() {
  statusEl.textContent = "";
  statusEl.className = "status";
}

function showError(message: string) {
  errorEl.textContent = message;
  errorEl.style.display = "block";
}

function clearError() {
  errorEl.textContent = "";
  errorEl.style.display = "none";
}

// ============================================================================
// Validation Utilities
// ============================================================================

function validateNamadaAddress(address: string): { valid: boolean; error?: string } {
  if (!address) {
    return { valid: false, error: "Namada address is required" };
  }
  if (!address.startsWith("tnam")) {
    return { 
      valid: false, 
      error: "Invalid Namada address: must start with 'tnam' (transparent address). Shielded addresses (znam) are not supported for direct deposits." 
    };
  }
  if (address.length < 40) {
    return { valid: false, error: "Invalid Namada address: address appears too short" };
  }
  return { valid: true };
}

function validateCosmosAddress(address: string): { valid: boolean; error?: string } {
  if (!address) {
    return { valid: false, error: "Cosmos Hub address is required for recovery/refund purposes" };
  }
  if (!address.startsWith("cosmos1")) {
    return { 
      valid: false, 
      error: "Invalid Cosmos Hub address: must start with 'cosmos1'" 
    };
  }
  if (address.length !== 45) {
    return { valid: false, error: `Invalid Cosmos Hub address: expected 45 characters, got ${address.length}` };
  }
  return { valid: true };
}

function validateAmount(amountStr: string): { valid: boolean; error?: string; weiStr?: string } {
  if (!amountStr || amountStr.trim() === "") {
    return { valid: false, error: "Amount is required" };
  }
  
  const amount = parseFloat(amountStr);
  if (isNaN(amount)) {
    return { valid: false, error: "Invalid amount: must be a valid number" };
  }
  if (amount <= 0) {
    return { valid: false, error: "Invalid amount: must be greater than 0" };
  }
  if (amount > 1000) {
    return { valid: false, error: "Invalid amount: maximum 1000 WETH per transfer (safety limit)" };
  }
  
  const weiStr = toWeiStr(amountStr);
  if (weiStr === "0") {
    return { valid: false, error: "Invalid amount: too small (rounds to 0 wei)" };
  }
  
  return { valid: true, weiStr };
}

function toWeiStr(amountStr: string): string {
  const [i, f] = amountStr.split(".");
  const int = (i || "0").replace(/^0+/, "") || "0";
  const frac = (f || "").padEnd(18, "0").slice(0, 18);
  return (int + frac).replace(/^0+/, "") || "0";
}

// ============================================================================
// MetaMask Wallet Connection
// ============================================================================

/**
 * Tests if a provider actually supports standard Ethereum JSON-RPC methods.
 * Some extensions claim isMetaMask but don't implement the full API.
 */
async function testProvider(provider: any): Promise<boolean> {
  try {
    // Try a simple read-only method that all Ethereum providers should support
    const chainId = await provider.request({ method: "eth_chainId" });
    return typeof chainId === "string" && chainId.startsWith("0x");
  } catch {
    return false;
  }
}

/**
 * Gets the MetaMask provider specifically, even when multiple wallet extensions are installed.
 * This handles the case where other extensions may override window.ethereum.
 * Returns a list of candidate providers to try.
 */
function getCandidateProviders(): any[] {
  const candidates: any[] = [];

  if (typeof window.ethereum === "undefined") {
    return candidates;
  }

  // If there are multiple providers (EIP-5749), collect all MetaMask-like ones
  if (window.ethereum.providers?.length) {
    for (const provider of window.ethereum.providers) {
      if (provider.isMetaMask) {
        candidates.push(provider);
      }
    }
  }

  // Also try the main window.ethereum if it claims to be MetaMask
  if (window.ethereum.isMetaMask && !candidates.includes(window.ethereum)) {
    candidates.push(window.ethereum);
  }

  // If no MetaMask found but window.ethereum exists, try it anyway as fallback
  if (candidates.length === 0 && window.ethereum) {
    candidates.push(window.ethereum);
  }

  return candidates;
}

let cachedProvider: any = null;

async function findWorkingProvider(): Promise<any | null> {
  if (cachedProvider) return cachedProvider;

  const candidates = getCandidateProviders();
  log(`Found ${candidates.length} candidate provider(s)`);

  for (let i = 0; i < candidates.length; i++) {
    const provider = candidates[i];
    log(`Testing provider ${i + 1}/${candidates.length}...`);
    
    if (await testProvider(provider)) {
      log(`Provider ${i + 1} works!`);
      cachedProvider = provider;
      return provider;
    } else {
      log(`Provider ${i + 1} failed basic test, trying next...`);
    }
  }

  return null;
}

function getProvider(): any {
  return cachedProvider;
}

async function checkCorrectNetwork(): Promise<boolean> {
  const provider = getProvider();
  if (!provider) return false;

  try {
    const chainId = await provider.request({ method: "eth_chainId" });
    return chainId === ETHEREUM_CHAIN_ID_HEX;
  } catch (error) {
    log(`Network check error: ${error}`);
    return false;
  }
}

async function switchToMainnet(): Promise<void> {
  const provider = getProvider();
  if (!provider) throw new Error("MetaMask not available");

  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: ETHEREUM_CHAIN_ID_HEX }],
    });
  } catch (error: any) {
    if (error.code === 4902) {
      throw new Error("Ethereum Mainnet not configured in MetaMask. Please add it manually.");
    }
    throw new Error(`Failed to switch network: ${error.message || "Unknown error"}`);
  }
}

async function connectMetaMask(): Promise<string> {
  log("Detecting wallet providers...");

  // Find a working provider
  const provider = await findWorkingProvider();
  
  if (!provider) {
    throw new Error(
      "No working Ethereum wallet found. Please ensure MetaMask is installed and enabled. " +
      "You have multiple browser extensions installed that may be conflicting. " +
      "Try these steps:\n" +
      "1. Open MetaMask and make sure it's unlocked\n" +
      "2. Disable other wallet extensions temporarily (Namada, Polkadot.js, Keplr, etc.)\n" +
      "3. Refresh this page and try again"
    );
  }

  log("Working provider found");

  // Check and switch to correct network
  log("Checking network...");
  const isCorrectNetwork = await checkCorrectNetwork();
  
  if (!isCorrectNetwork) {
    log("Not on Ethereum Mainnet, attempting to switch...");
    try {
      await switchToMainnet();
      log("Switched to Ethereum Mainnet");
    } catch (error: any) {
      throw new Error(
        `Please manually switch to Ethereum Mainnet in your wallet. ` +
        `(${error.message})`
      );
    }
  } else {
    log("Already on Ethereum Mainnet");
  }

  // Request account access
  log("Requesting account access...");
  try {
    const accounts = await provider.request({
      method: "eth_requestAccounts",
    });

    if (!accounts || accounts.length === 0) {
      throw new Error("No accounts returned. Please unlock your wallet and try again.");
    }

    return accounts[0];
  } catch (error: any) {
    if (error.code === 4001) {
      throw new Error("Connection rejected: You declined the wallet connection request.");
    }
    if (error.code === -32002) {
      throw new Error("Connection pending: Please check your wallet for a pending connection request.");
    }
    throw new Error(`Failed to connect wallet: ${error.message || "Unknown error"}`);
  }
}

function updateWalletUI(account: string | null) {
  if (account) {
    const shortAddr = `${account.slice(0, 6)}...${account.slice(-4)}`;
    walletStatusEl.textContent = `Connected: ${shortAddr}`;
    walletStatusEl.className = "wallet-connected";
    connectBtn.textContent = "Wallet Connected";
    (connectBtn as HTMLButtonElement).disabled = true;
    (transferBtn as HTMLButtonElement).disabled = false;
  } else {
    walletStatusEl.textContent = "Not connected";
    walletStatusEl.className = "wallet-disconnected";
    connectBtn.textContent = "Connect MetaMask";
    (connectBtn as HTMLButtonElement).disabled = false;
    (transferBtn as HTMLButtonElement).disabled = true;
  }
}

// ============================================================================
// Contract ABIs
// ============================================================================

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
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

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

// ============================================================================
// Main Transfer Function
// ============================================================================

async function sendEurekaWithPFM(
  namadaReceiver: string,
  cosmosRecoveryAddr: string,
  amountWei: bigint
) {
  if (!connectedAccount) {
    throw new Error("Wallet not connected. Please connect MetaMask first.");
  }

  const provider = getProvider();
  if (!provider) {
    throw new Error("MetaMask not available");
  }

  // Verify still on correct network
  if (!(await checkCorrectNetwork())) {
    throw new Error("Wrong network detected. Please switch to Ethereum Mainnet in MetaMask.");
  }

  const client = createWalletClient({
    account: connectedAccount as `0x${string}`,
    chain: mainnet,
    transport: custom(provider),
  });

  // Step 0: Get relay fee quote from Skip
  setStatus("Fetching relay fee quote from Skip...", "info");
  log("Requesting route from Skip API...");

  let routeResponse;
  try {
    routeResponse = await route({
      sourceAssetChainId: ETHEREUM_CHAIN_ID,
      sourceAssetDenom: WETH,
      destAssetChainId: COSMOS_CHAIN_ID,
      destAssetDenom: COSMOS_IBC_WETH,
      amountIn: String(amountWei),
      smartRelay: true,
      experimentalFeatures: ["eureka"],
    });
  } catch (error: any) {
    const errorMsg = error.message || "Unknown error";
    
    // Check for the specific USD value difference error
    if (errorMsg.includes("USD value") || errorMsg.includes("too large")) {
      throw new Error(
        `Transfer amount too small: The relay fee would consume too much of your transfer. ` +
        `Skip requires that fees don't exceed ~50% of the transfer value. ` +
        `Please increase the amount to at least 0.005 WETH (~$15+).`
      );
    }
    
    throw new Error(
      `Failed to get route from Skip API: ${errorMsg}. ` +
      `This could be due to network issues or the Skip service being unavailable.`
    );
  }

  const eurekaTransfer = routeResponse.operations?.[0]?.eurekaTransfer;
  if (!eurekaTransfer) {
    throw new Error(
      "Invalid response from Skip API: missing eurekaTransfer data. " +
      "The API response structure may have changed or the route is not supported."
    );
  }

  const feeInfo = eurekaTransfer.smartRelayFeeQuote;
  if (!feeInfo) {
    throw new Error(
      "Invalid response from Skip API: missing relay fee quote. " +
      "Smart relay may not be available for this route."
    );
  }

  const relayFee = BigInt(feeInfo.feeAmount);
  const relayFeeRecipient = feeInfo.feePaymentAddress;
  const expirationStr = feeInfo.expiration;
  const expirationSec = Math.floor(Date.parse(expirationStr) / 1000);
  const quoteExpiry = BigInt(expirationSec);

  const callbackAddress = eurekaTransfer.toChainCallbackContractAddress;
  const entryContract = eurekaTransfer.toChainEntryContractAddress;

  if (!callbackAddress || !entryContract) {
    throw new Error(
      "Invalid response from Skip API: missing callback or entry contract addresses."
    );
  }

  log(`Relay fee: ${formatUnits(relayFee, 18)} WETH`);
  log(`Callback contract: ${callbackAddress}`);
  log(`Entry contract: ${entryContract}`);

  // Calculate received amount
  const receivedAmount = amountWei - relayFee;
  if (receivedAmount <= 0n) {
    throw new Error(
      `Transfer amount (${formatUnits(amountWei, 18)} WETH) is less than or equal to the relay fee ` +
      `(${formatUnits(relayFee, 18)} WETH). Please increase the transfer amount.`
    );
  }

  log(`Amount after relay fee: ${formatUnits(receivedAmount, 18)} WETH`);

  // Step 1: Approve WETH spending
  setStatus("Step 1/2: Approving WETH spending... (check MetaMask)", "info");
  log("Requesting WETH approval in MetaMask...");

  try {
    const approveHash = await client.writeContract({
      address: WETH as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [ETHEREUM_PROXY_ADDR as `0x${string}`, amountWei],
      account: connectedAccount as `0x${string}`,
    });
    log(`Approval tx submitted: ${approveHash}`);
    log("Waiting for approval confirmation...");
  } catch (error: any) {
    if (error.message?.includes("User rejected") || error.code === 4001) {
      throw new Error("Transaction rejected: You declined the WETH approval in MetaMask.");
    }
    throw new Error(`WETH approval failed: ${error.message || "Unknown error"}`);
  }

  // Step 2: Prepare and send the transfer
  setStatus("Step 2/2: Sending transfer... (check MetaMask)", "info");

  const nowSec = Math.floor(Date.now() / 1000);
  // IMPORTANT: 12 hours timeout because Skip relayer ignores packets with <10 hours timeout
  const timeout = BigInt(nowSec + 43200);
  const timeoutDate = new Date((nowSec + 43200) * 1000).toLocaleString();
  log(`Timeout set to: ${timeoutDate} (12 hours from now)`);

  // Construct the forwarding memo
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
                memo: "", // Must be empty - forwarding reuses this field
                receiver: namadaReceiver,
                recover_address: cosmosRecoveryAddr,
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

  log("Submitting transfer transaction...");

  try {
    const txHash = await client.writeContract({
      address: ETHEREUM_PROXY_ADDR as `0x${string}`,
      abi: PROXY_ABI,
      functionName: "transfer",
      args: [
        receivedAmount,
        {
          token: WETH as `0x${string}`,
          recipient: callbackAddress,
          sourceClient: COSMOS_ETHEREUM_CLIENT,
          destPort: COSMOS_PORT,
          timeoutTimestamp: timeout,
          memo,
        },
        {
          relayFee,
          relayFeeRecipient: relayFeeRecipient as `0x${string}`,
          quoteExpiry,
        },
      ],
      account: connectedAccount as `0x${string}`,
    });

    log(`✓ Transfer tx submitted: ${txHash}`);
    log(`View on Etherscan: https://etherscan.io/tx/${txHash}`);
    log("");
    log("Transfer initiated successfully!");
    log("The Skip relayer will now pick up this transaction and relay it to Cosmos Hub,");
    log("then the CosmWasm contract will forward it to Namada.");
    log("This typically takes ~20 minutes. Monitor the transaction on Etherscan.");
    
    setStatus("Transfer submitted! Relaying takes ~20 minutes.", "success");
    
    return txHash;
  } catch (error: any) {
    if (error.message?.includes("User rejected") || error.code === 4001) {
      throw new Error("Transaction rejected: You declined the transfer in MetaMask.");
    }
    if (error.message?.includes("insufficient funds")) {
      throw new Error(
        "Insufficient funds: You don't have enough ETH to pay for gas, " +
        "or not enough WETH for the transfer amount."
      );
    }
    throw new Error(`Transfer failed: ${error.message || "Unknown error"}`);
  }
}

// ============================================================================
// Event Handlers
// ============================================================================

connectBtn.addEventListener("click", async () => {
  clearError();
  setStatus("Connecting to MetaMask...", "info");

  try {
    const account = await connectMetaMask();
    connectedAccount = account;
    updateWalletUI(account);
    log(`Wallet connected: ${account}`);
    setStatus("Wallet connected successfully!", "success");
    setTimeout(clearStatus, 3000);
  } catch (error: any) {
    showError(error.message);
    setStatus("Connection failed", "warning");
    log(`Connection error: ${error.message}`);
  }
});

transferBtn.addEventListener("click", async () => {
  clearError();

  // Validate all inputs
  const amountStr = amountInput.value.trim();
  const namadaAddr = tnamInput.value.trim();
  const cosmosAddr = cosmosInput.value.trim();

  // Validate amount
  const amountValidation = validateAmount(amountStr);
  if (!amountValidation.valid) {
    showError(amountValidation.error!);
    return;
  }

  // Validate Namada address
  const namadaValidation = validateNamadaAddress(namadaAddr);
  if (!namadaValidation.valid) {
    showError(namadaValidation.error!);
    return;
  }

  // Validate Cosmos address
  const cosmosValidation = validateCosmosAddress(cosmosAddr);
  if (!cosmosValidation.valid) {
    showError(cosmosValidation.error!);
    return;
  }

  // Disable button during transfer
  (transferBtn as HTMLButtonElement).disabled = true;

  try {
    log("─".repeat(50));
    log(`Initiating transfer of ${amountStr} WETH`);
    log(`To Namada: ${namadaAddr}`);
    log(`Recovery address: ${cosmosAddr}`);
    log("─".repeat(50));

    await sendEurekaWithPFM(namadaAddr, cosmosAddr, BigInt(amountValidation.weiStr!));
  } catch (error: any) {
    showError(error.message);
    setStatus("Transfer failed", "warning");
    log(`ERROR: ${error.message}`);
  } finally {
    // Re-enable button if wallet is still connected
    if (connectedAccount) {
      (transferBtn as HTMLButtonElement).disabled = false;
    }
  }
});

// Listen for account changes - set up after a short delay to ensure provider is detected
function setupProviderListeners() {
  const provider = getProvider();
  if (provider) {
    provider.on("accountsChanged", (accounts: string[]) => {
      if (accounts.length === 0) {
        connectedAccount = null;
        updateWalletUI(null);
        log("Wallet disconnected");
      } else if (accounts[0] !== connectedAccount) {
        connectedAccount = accounts[0];
        updateWalletUI(accounts[0]);
        log(`Account changed to: ${accounts[0]}`);
      }
    });

    provider.on("chainChanged", (chainId: string) => {
      if (chainId !== ETHEREUM_CHAIN_ID_HEX) {
        showError("Wrong network! Please switch to Ethereum Mainnet in MetaMask.");
        log(`Network changed to chain ID ${chainId} - please switch back to Mainnet`);
      } else {
        clearError();
        log("Network: Ethereum Mainnet");
      }
    });

    log("MetaMask event listeners registered");
  }
}

// Defer listener setup to allow provider detection
setTimeout(setupProviderListeners, 100);

// Initial UI state
updateWalletUI(null);
log("Application loaded. Connect your MetaMask wallet to begin.");
