import {
  createWalletClient,
  encodeFunctionData,
  erc20Abi as ERC20_ABI,
  formatUnits,
  Hex,
  http,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createAcrossClient } from "@across-protocol/app-sdk";
import { EvmWalletProvider } from "../../wallet-providers";
import { CHAIN_ID_TO_NETWORK_ID, getChain, NETWORK_ID_TO_VIEM_CHAIN } from "../../network";
import { isAcrossSupportedTestnet } from "../across/utils";
import { approve } from "../../utils";
import {
  ACROSS_DEPOSIT_STATUS_API,
  COMET_SUPPLY_ABI,
  METAMORPHO_DEPOSIT_ABI,
  SUPPORTED_DESTINATION_CHAIN_IDS,
} from "./constants";

/**
 * The result of initiating an Across bridge deposit.
 */
export interface InitiateDepositResult {
  depositId: string;
  originChainId: number;
  destinationChainId: number;
  inputAmount: string;
  outputAmount: string;
  /** The address of the bridged token on the destination chain. */
  outputToken: string;
  depositTxHash: string;
  approvalTxHash?: string;
}

/**
 * Checks whether a chain ID is a supported destination for the deploy leg.
 *
 * @param chainId - The destination chain ID to validate.
 * @returns True if the chain is a supported deploy destination (Base-first).
 */
export function isSupportedDestinationChain(chainId: number): boolean {
  return SUPPORTED_DESTINATION_CHAIN_IDS.includes(chainId);
}

/**
 * Initiates an Across bridge deposit from the wallet's current chain to a
 * destination chain. Mirrors the in-tree `across` provider's bridge flow.
 *
 * @param walletProvider - The wallet provider initiating the bridge.
 * @param privateKey - The private key matching the wallet provider (for the Across SDK wallet client).
 * @param params - The bridge parameters.
 * @param params.tokenSymbol - The symbol of the token to bridge (e.g. "ETH", "USDC").
 * @param params.amount - The amount to bridge in whole units.
 * @param params.destinationChainId - The destination chain ID.
 * @param params.recipient - The recipient address on the destination chain.
 * @param params.maxSlippageBps - The maximum acceptable slippage in basis points.
 * @returns The deposit result including the deposit ID and tx hashes.
 */
export async function initiateAcrossDeposit(
  walletProvider: EvmWalletProvider,
  privateKey: string,
  params: {
    tokenSymbol: string;
    amount: string;
    destinationChainId: number;
    recipient: Hex;
    maxSlippageBps: number;
  },
): Promise<InitiateDepositResult> {
  const address = walletProvider.getAddress() as Hex;

  // Resolve origin chain
  const originChain = getChain(walletProvider.getNetwork().chainId as string);
  if (!originChain) {
    throw new Error(`Unsupported origin chain: ${walletProvider.getNetwork().chainId}`);
  }

  // Resolve destination chain
  const destinationNetworkId = CHAIN_ID_TO_NETWORK_ID[params.destinationChainId];
  const destinationChain = NETWORK_ID_TO_VIEM_CHAIN[destinationNetworkId];
  if (!destinationChain) {
    throw new Error(`Unsupported destination chain: ${params.destinationChainId}`);
  }
  if (originChain.id === destinationChain.id) {
    throw new Error("Origin and destination chains cannot be the same");
  }

  const useTestnet = isAcrossSupportedTestnet(originChain.id);
  if (useTestnet !== isAcrossSupportedTestnet(destinationChain.id)) {
    throw new Error(
      `Cross-chain transfers between ${originChain.name} and ${destinationChain.name} are not supported. Origin and destination chains must both be testnets or both be mainnets.`,
    );
  }

  // Create the wallet client used by the Across SDK to submit the deposit
  const account = privateKeyToAccount(privateKey as Hex);
  if (account.address !== address) {
    throw new Error("Private key does not match wallet provider address");
  }
  const walletClient = createWalletClient({
    account,
    chain: originChain,
    transport: http(),
  });

  const acrossClient = createAcrossClient({
    chains: [originChain, destinationChain],
    useTestnet,
  });

  // Resolve token info on the origin chain
  const chainDetails = await acrossClient.getSupportedChains({});
  const originChainDetails = chainDetails.find(chain => chain.chainId === originChain.id);
  if (!originChainDetails) {
    throw new Error(`Origin chain ${originChain.id} not supported by Across Protocol`);
  }
  const inputTokens = originChainDetails.inputTokens;
  if (!inputTokens || inputTokens.length === 0) {
    throw new Error(`No input tokens available on chain ${originChain.id}`);
  }
  const tokenInfo = inputTokens.find(
    token => token.symbol.toUpperCase() === params.tokenSymbol.toUpperCase(),
  );
  if (!tokenInfo) {
    throw new Error(
      `Token ${params.tokenSymbol} not found on chain ${originChain.id}. Available tokens: ${inputTokens.map(t => t.symbol).join(", ")}`,
    );
  }

  const inputToken = tokenInfo.address as Hex;
  const decimals = tokenInfo.decimals;
  const inputAmount = parseUnits(params.amount, decimals);
  const isNative = params.tokenSymbol.toUpperCase() === "ETH";

  // Balance preflight
  if (isNative) {
    const ethBalance = await walletProvider.getBalance();
    if (ethBalance < inputAmount) {
      throw new Error(
        `Insufficient balance. Requested to bridge ${formatUnits(inputAmount, decimals)} ${params.tokenSymbol} but balance is only ${formatUnits(ethBalance, decimals)} ${params.tokenSymbol}`,
      );
    }
  } else {
    const tokenBalance = (await walletProvider.readContract({
      address: inputToken,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [address],
    })) as bigint;
    if (tokenBalance < inputAmount) {
      throw new Error(
        `Insufficient balance. Requested to bridge ${formatUnits(inputAmount, decimals)} ${params.tokenSymbol} but balance is only ${formatUnits(tokenBalance, decimals)} ${params.tokenSymbol}`,
      );
    }
  }

  // Resolve route + quote
  const routeInfo = await acrossClient.getAvailableRoutes({
    originChainId: originChain.id,
    destinationChainId: destinationChain.id,
    originToken: inputToken,
  });
  const route = routeInfo.find(r => r.isNative === isNative);
  if (!route) {
    throw new Error(
      `No routes available from ${originChain.name} to ${destinationChain.name} for token ${params.tokenSymbol}`,
    );
  }

  const quote = await acrossClient.getQuote({
    route,
    inputAmount,
    recipient: params.recipient,
  });

  const formattedInput = formatUnits(quote.deposit.inputAmount, decimals);
  const formattedOutput = formatUnits(quote.deposit.outputAmount, decimals);

  // Slippage check (basis points) — computed with bigint to avoid float rounding.
  const slippageBps = Number(
    ((quote.deposit.inputAmount - quote.deposit.outputAmount) * 10000n) / quote.deposit.inputAmount,
  );
  if (slippageBps > params.maxSlippageBps) {
    throw new Error(
      `Bridge slippage of ${slippageBps.toFixed(0)} bps exceeds the maximum allowed ${params.maxSlippageBps} bps. Input: ${formattedInput} ${params.tokenSymbol}, Output: ${formattedOutput} ${params.tokenSymbol}`,
    );
  }

  // Approve the SpokePool for ERC20 tokens
  let approvalTxHash: Hex | undefined;
  if (!isNative) {
    approvalTxHash = await walletProvider.sendTransaction({
      to: inputToken,
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        args: [quote.deposit.spokePoolAddress, quote.deposit.inputAmount],
      }),
    });
    await walletProvider.waitForTransactionReceipt(approvalTxHash);
  }

  // Simulate + submit the deposit
  const { request } = await acrossClient.simulateDepositTx({
    walletClient,
    deposit: quote.deposit,
  });
  const depositTxHash = await walletClient.writeContract(request);

  const { depositId } = await acrossClient.waitForDepositTx({
    transactionHash: depositTxHash,
    originChainId: originChain.id,
  });

  // Address of the bridged token on the destination chain, used to supply later.
  const outputToken = quote.deposit.outputToken as string;

  return {
    depositId: String(depositId),
    originChainId: originChain.id,
    destinationChainId: destinationChain.id,
    inputAmount: formattedInput,
    outputAmount: formattedOutput,
    outputToken,
    depositTxHash,
    approvalTxHash,
  };
}

/**
 * The structured status of an Across deposit.
 */
export interface DepositStatus {
  status: string;
  fillTx: string | null;
  depositTxHash: string | null;
  depositRefundTxHash: string | null;
  originChainId: number | null;
  destinationChainId: number | null;
}

/**
 * Fetches the status of an Across deposit from the deposit-status API.
 *
 * @param originChainId - The origin chain ID of the deposit.
 * @param depositId - The deposit ID to look up.
 * @returns The structured deposit status.
 */
export async function getDepositStatus(
  originChainId: number,
  depositId: string,
): Promise<DepositStatus> {
  const url = new URL(ACROSS_DEPOSIT_STATUS_API);
  url.searchParams.set("originChainId", String(originChainId));
  url.searchParams.set("depositId", depositId);
  const response = await fetch(url.toString(), { method: "GET" });

  if (!response.ok) {
    throw new Error(`Across API request failed with status ${response.status}`);
  }

  const apiData = await response.json();

  return {
    status: apiData.status || "unknown",
    fillTx: apiData.fillTx || null,
    depositTxHash: apiData.depositTxHash || null,
    depositRefundTxHash: apiData.depositRefundTxHash || null,
    originChainId: apiData.originChainId ?? null,
    destinationChainId: apiData.destinationChainId ?? null,
  };
}

/**
 * The recorded intent to supply a bridged token into a destination position.
 */
export interface PendingDeploy {
  protocol: "compound" | "morpho";
  token: string;
  amount: string;
  protocolMarketAddress: string;
  chainId: number;
  recipient: Hex;
}

/**
 * Supplies an (already-bridged) token into a destination lending/vault position.
 * Performs a balance preflight, approves the market, then supplies. Re-runnable:
 * it always re-checks the on-chain balance before acting.
 *
 * @param walletProvider - The wallet provider executing the supply.
 * @param params - The deploy parameters.
 * @param allowPartial - When true (auto-deploy after a bridge fill), supplies
 *   the amount that actually landed if the fill came in under the recorded
 *   quote, rather than failing the preflight. When false (an explicit
 *   deploy_on_destination call), the caller asked for an exact amount, so a
 *   short balance is an error.
 * @returns A human-readable summary including the supply transaction hash.
 */
export async function deployToProtocol(
  walletProvider: EvmWalletProvider,
  params: PendingDeploy,
  allowPartial = false,
): Promise<string> {
  if (!isSupportedDestinationChain(params.chainId)) {
    return `Error: destination protocol deployment is only supported on Base (chain IDs ${SUPPORTED_DESTINATION_CHAIN_IDS.join(", ")}), not chain ${params.chainId}`;
  }

  const token = params.token as Hex;

  // Resolve decimals + balance preflight (bridge may not have filled yet)
  const decimals = (await walletProvider.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "decimals",
    args: [],
  })) as number;
  const requestedAmount = parseUnits(params.amount, decimals);

  const balance = (await walletProvider.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [walletProvider.getAddress() as Hex],
  })) as bigint;

  // The recorded amount is the *quoted* bridge output; the actual fill can come
  // in slightly under (fees change between quote and fill). For the auto-deploy
  // path, supply whatever landed; for an explicit call, require the full amount.
  let atomicAmount = requestedAmount;
  if (balance < requestedAmount) {
    if (allowPartial && balance > 0n) {
      atomicAmount = balance;
    } else {
      return `Error: insufficient balance on destination chain to supply ${params.amount}. Available: ${formatUnits(balance, decimals)}. The bridge may not have filled yet — call bridge_deploy_status and retry once 'filled'.`;
    }
  }
  const suppliedAmount = formatUnits(atomicAmount, decimals);

  // Approve the destination market to pull the token
  const approvalResult = await approve(
    walletProvider,
    params.token,
    params.protocolMarketAddress,
    atomicAmount,
  );
  if (approvalResult.startsWith("Error")) {
    return `Error approving ${params.protocol} market as spender: ${approvalResult}`;
  }

  // Encode + submit the protocol-specific supply. Compound's `supply` credits
  // msg.sender, so `supplyTo` is used to honor an explicit recipient.
  let data: Hex;
  if (params.protocol === "compound") {
    data = encodeFunctionData({
      abi: COMET_SUPPLY_ABI,
      functionName: "supplyTo",
      args: [params.recipient, token, atomicAmount],
    });
  } else {
    data = encodeFunctionData({
      abi: METAMORPHO_DEPOSIT_ABI,
      functionName: "deposit",
      args: [atomicAmount, params.recipient],
    });
  }

  const txHash = await walletProvider.sendTransaction({
    to: params.protocolMarketAddress as Hex,
    data,
  });
  await walletProvider.waitForTransactionReceipt(txHash);

  return `Supplied ${suppliedAmount} of token ${params.token} into ${params.protocol} market ${params.protocolMarketAddress} on chain ${params.chainId} for ${params.recipient}. Transaction hash: ${txHash}`;
}
