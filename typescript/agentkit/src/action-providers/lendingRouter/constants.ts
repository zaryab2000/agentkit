import { Address } from "viem";
import { erc20Abi as ERC20_ABI } from "viem";

export { ERC20_ABI };

export const SECONDS_PER_YEAR_NUMBER = 31_536_000;

export const RAY = 10n ** 27n;

export const HEALTH_FACTOR_THRESHOLD = 1.05;

export const SUPPORTED_ASSETS: Record<string, Address> = {
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  weth: "0x4200000000000000000000000000000000000006",
  cbeth: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22",
  cbbtc: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
  wsteth: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452",
};

// --- Compound III (Comet) on Base mainnet ---
export const COMPOUND_COMET_ADDRESS: Address = "0xb125E6687d4313864e53df431d5425969c15Eb2F";

export const COMPOUND_COMET_ABI = [
  {
    inputs: [],
    name: "getUtilization",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "utilization", type: "uint256" }],
    name: "getSupplyRate",
    outputs: [{ internalType: "uint64", name: "", type: "uint64" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "utilization", type: "uint256" }],
    name: "getBorrowRate",
    outputs: [{ internalType: "uint64", name: "", type: "uint64" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "asset", type: "address" },
      { internalType: "uint256", name: "amount", type: "uint256" },
    ],
    name: "supply",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "asset", type: "address" },
      { internalType: "uint256", name: "amount", type: "uint256" },
    ],
    name: "withdraw",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "account", type: "address" }],
    name: "borrowBalanceOf",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "numAssets",
    outputs: [{ internalType: "uint8", name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint8", name: "i", type: "uint8" }],
    name: "getAssetInfo",
    outputs: [
      {
        components: [
          { internalType: "uint8", name: "offset", type: "uint8" },
          { internalType: "address", name: "asset", type: "address" },
          { internalType: "address", name: "priceFeed", type: "address" },
          { internalType: "uint64", name: "scale", type: "uint64" },
          { internalType: "uint64", name: "borrowCollateralFactor", type: "uint64" },
          { internalType: "uint64", name: "liquidateCollateralFactor", type: "uint64" },
          { internalType: "uint64", name: "liquidationFactor", type: "uint64" },
          { internalType: "uint128", name: "supplyCap", type: "uint128" },
        ],
        internalType: "struct CometCore.AssetInfo",
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "baseToken",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "baseTokenPriceFeed",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "priceFeed", type: "address" }],
    name: "getPrice",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "account", type: "address" },
      { internalType: "address", name: "asset", type: "address" },
    ],
    name: "collateralBalanceOf",
    outputs: [{ internalType: "uint128", name: "balance", type: "uint128" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// --- Aave v3 on Base mainnet ---
export const AAVE_POOL_ADDRESS: Address = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";

export const AAVE_POOL_ABI = [
  {
    inputs: [{ internalType: "address", name: "asset", type: "address" }],
    name: "getReserveData",
    outputs: [
      {
        components: [
          { internalType: "uint256", name: "configuration", type: "uint256" },
          { internalType: "uint128", name: "liquidityIndex", type: "uint128" },
          { internalType: "uint128", name: "currentLiquidityRate", type: "uint128" },
          { internalType: "uint128", name: "variableBorrowIndex", type: "uint128" },
          { internalType: "uint128", name: "currentVariableBorrowRate", type: "uint128" },
          { internalType: "uint128", name: "currentStableBorrowRate", type: "uint128" },
          { internalType: "uint40", name: "lastUpdateTimestamp", type: "uint40" },
          { internalType: "uint16", name: "id", type: "uint16" },
          { internalType: "address", name: "aTokenAddress", type: "address" },
          { internalType: "address", name: "stableDebtTokenAddress", type: "address" },
          { internalType: "address", name: "variableDebtTokenAddress", type: "address" },
          { internalType: "address", name: "interestRateStrategyAddress", type: "address" },
          { internalType: "uint128", name: "accruedToTreasury", type: "uint128" },
          { internalType: "uint256", name: "unbacked", type: "uint256" },
          { internalType: "uint256", name: "isolationModeTotalDebt", type: "uint256" },
        ],
        internalType: "struct DataTypes.ReserveDataLegacy",
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "user", type: "address" }],
    name: "getUserAccountData",
    outputs: [
      { internalType: "uint256", name: "totalCollateralBase", type: "uint256" },
      { internalType: "uint256", name: "totalDebtBase", type: "uint256" },
      { internalType: "uint256", name: "availableBorrowsBase", type: "uint256" },
      { internalType: "uint256", name: "currentLiquidationThreshold", type: "uint256" },
      { internalType: "uint256", name: "ltv", type: "uint256" },
      { internalType: "uint256", name: "healthFactor", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "asset", type: "address" },
      { internalType: "uint256", name: "amount", type: "uint256" },
      { internalType: "address", name: "onBehalfOf", type: "address" },
      { internalType: "uint16", name: "referralCode", type: "uint16" },
    ],
    name: "supply",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "asset", type: "address" },
      { internalType: "uint256", name: "amount", type: "uint256" },
      { internalType: "uint256", name: "interestRateMode", type: "uint256" },
      { internalType: "uint16", name: "referralCode", type: "uint16" },
      { internalType: "address", name: "onBehalfOf", type: "address" },
    ],
    name: "borrow",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "asset", type: "address" },
      { internalType: "uint256", name: "amount", type: "uint256" },
      { internalType: "uint256", name: "interestRateMode", type: "uint256" },
      { internalType: "address", name: "onBehalfOf", type: "address" },
    ],
    name: "repay",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "asset", type: "address" },
      { internalType: "uint256", name: "amount", type: "uint256" },
      { internalType: "address", name: "to", type: "address" },
    ],
    name: "withdraw",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

// --- Moonwell on Base mainnet ---
export const MOONWELL_COMPTROLLER_ADDRESS: Address = "0xfBb21d0380beE3312B33c4353c8936a0F13EF26C";

export const MOONWELL_MTOKEN_ADDRESSES: Record<string, Address> = {
  usdc: "0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22",
  weth: "0x628ff693426583D9a7FB391E54366292F509D457",
  cbeth: "0x3bf93770f2d4a0F9a5a5F3d1a1e3a0c9B6C7E3e5",
  cbbtc: "0xF877ACaFA28c19b96727966b8f0A3f4C4Ba4D4bD",
  wsteth: "0x627Fe393Bc6EdDA28e99AE648fD6fF362514304b",
};

export const MOONWELL_MTOKEN_ABI = [
  {
    inputs: [],
    name: "supplyRatePerTimestamp",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "borrowRatePerTimestamp",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "mintAmount", type: "uint256" }],
    name: "mint",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "redeemAmount", type: "uint256" }],
    name: "redeem",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "account", type: "address" }],
    name: "balanceOfUnderlying",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "account", type: "address" }],
    name: "borrowBalanceCurrent",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export const MOONWELL_COMPTROLLER_ABI = [
  {
    inputs: [{ internalType: "address", name: "account", type: "address" }],
    name: "getAccountLiquidity",
    outputs: [
      { internalType: "uint256", name: "", type: "uint256" },
      { internalType: "uint256", name: "", type: "uint256" },
      { internalType: "uint256", name: "", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

// --- Morpho Blue on Base mainnet ---
export const MORPHO_BLUE_ADDRESS: Address = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
export const MORPHO_GRAPHQL_ENDPOINT = "https://blue-api.morpho.org/graphql";

export const MORPHO_BLUE_ABI = [
  {
    inputs: [
      { internalType: "bytes32", name: "id", type: "bytes32" },
      { internalType: "address", name: "user", type: "address" },
    ],
    name: "position",
    outputs: [
      { internalType: "uint256", name: "supplyShares", type: "uint256" },
      { internalType: "uint128", name: "borrowShares", type: "uint128" },
      { internalType: "uint128", name: "collateral", type: "uint128" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "bytes32", name: "id", type: "bytes32" }],
    name: "market",
    outputs: [
      { internalType: "uint128", name: "totalSupplyAssets", type: "uint128" },
      { internalType: "uint128", name: "totalSupplyShares", type: "uint128" },
      { internalType: "uint128", name: "totalBorrowAssets", type: "uint128" },
      { internalType: "uint128", name: "totalBorrowShares", type: "uint128" },
      { internalType: "uint128", name: "lastUpdate", type: "uint128" },
      { internalType: "uint128", name: "fee", type: "uint128" },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

export const PROTOCOL_NAMES = ["compound", "aave", "moonwell", "morpho"] as const;
export type ProtocolName = (typeof PROTOCOL_NAMES)[number];
