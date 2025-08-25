import { SkipClient } from "@skip-go/client";
import { SigningStargateClient, coins } from "@cosmjs/stargate";

declare global { interface Window { ethereum?: any; keplr?: any; } }

const logEl = document.getElementById("log")!;
const btn1 = document.getElementById("step1")!;
const btn2 = document.getElementById("step2")!;
const amountInput = document.getElementById("amount") as HTMLInputElement;
const tnamInput = document.getElementById("tnam") as HTMLInputElement;

const ETHEREUM_CHAIN_ID = "1";
const COSMOS_CHAIN_ID = "cosmoshub-4";
const COSMOS_RPC = "https://rpc.cosmoshub.strange.love";
const WETH_MAINNET = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const COSMOS_TO_NAMADA_CHANNEL = "channel-1317";

let cachedDestIbcDenomOnHub: string|undefined;

function log(...args:any[]) { logEl.textContent += args.join(" ") + "\n"; }

async function getEthAddress():Promise<string> {
  const accs = await window.ethereum.request({ method:"eth_requestAccounts" });
  return accs[0];
}
async function getKeplrAddress(chainId:string):Promise<string> {
  await window.keplr.enable(chainId); const key=await window.keplr.getKey(chainId); return key.bech32Address;
}
async function getKeplrSigner(chainId:string){ await window.keplr.enable(chainId); return window.keplr.getOfflineSignerAuto(chainId); }

function toWeiStr(amountStr:string):string {
  const [i,f] = amountStr.split("."); const int=(i||"0").replace(/^0+/,"")||"0";
  const frac=(f||"").padEnd(18,"0").slice(0,18);
  return (int+frac).replace(/^0+/,"")||"0";
}

btn1.addEventListener("click", async()=>{
  try{
    log("Step1 start");
    const amountWei=toWeiStr(amountInput.value.trim());
    const ethAddr=await getEthAddress();
    const cosmosAddr=await getKeplrAddress(COSMOS_CHAIN_ID);
    const skip=new SkipClient({ getEVMSigner:async()=>window.ethereum! });
    const route=await skip.route({ sourceAssetChainID:ETHEREUM_CHAIN_ID, sourceAssetDenom:WETH_MAINNET,
      destAssetChainID:COSMOS_CHAIN_ID, amountIn:amountWei, smartRelay:true });
    const userAddresses=[{chainID:ETHEREUM_CHAIN_ID,address:ethAddr},{chainID:COSMOS_CHAIN_ID,address:cosmosAddr}];
    await skip.executeRoute({ route,userAddresses,getEvmSigner:()=>window.ethereum!,getCosmosSigner:async()=>await getKeplrSigner(COSMOS_CHAIN_ID)});
    cachedDestIbcDenomOnHub=(route as any)?.destAsset?.denom;
    log("Step1 done. Cosmos denom:",cachedDestIbcDenomOnHub);
  }catch(e:any){log("Step1 error",e.message);}
});

btn2.addEventListener("click", async()=>{
  try{
    log("Step2 start");
    const cosmosSigner=await getKeplrSigner(COSMOS_CHAIN_ID);
    const client=await SigningStargateClient.connectWithSigner(COSMOS_RPC,cosmosSigner);
    const from=await getKeplrAddress(COSMOS_CHAIN_ID);
    const toNamada=tnamInput.value.trim(); if(!toNamada) throw new Error("tnam required");
    const denom=cachedDestIbcDenomOnHub||prompt("CosmosHub denom (ibc/XXX)")||"";
    const amountWei=toWeiStr(amountInput.value.trim());
    const timeoutTs=Date.now()+20*60*1000;
    const res=await client.sendIbcTokens(from,toNamada,coins(amountWei,denom),"transfer",COSMOS_TO_NAMADA_CHANNEL,undefined,timeoutTs);
    log("IBC send result",JSON.stringify(res));
  }catch(e:any){log("Step2 error",e.message);}
});
