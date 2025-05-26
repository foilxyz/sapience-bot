import 'dotenv/config';
import { createWalletClient, type Address, erc20Abi, parseEther, http, formatEther, createPublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import Foil from './Foil.json' assert { type: 'json' };
import { request, gql } from 'graphql-request';
import { type MarketGroupType, type MarketType } from './graphql';
import fetch from 'node-fetch';
import OpenAI from 'openai';

const SUSDS_ADDRESS: Address = '0x5875eEE11Cf8398102FdAd704C9E96607675467a';
const WAGER_AMOUNT = parseEther('1'); // 1 sUSDS
const ETHEREUM_PRIVATE_KEY = process.env.ETHEREUM_PRIVATE_KEY;

// Find the prediction market closing next
async function fetchNextClosingMarket(): Promise<MarketType> {
  const query = gql`
    query GetNextMarkets($collateralAsset: String!, $chainId: Int!, $currentTime: String!, $baseTokenName: String!) {
      marketGroups(
        chainId: $chainId,
        collateralAsset: $collateralAsset,
        baseTokenName: $baseTokenName
      ) {
        address
        markets(
          filter: { 
            endTimestamp_gt: $currentTime, # Market ends in the future
          }
        ) {
          question
          marketId
          endTimestamp
          public
        }
      }
    }
  `;

  const responseData = await request<{ marketGroups: Array<MarketGroupType>; }>( 'https://api.sapience.xyz/graphql', query, {
    chainId: base.id,
    collateralAsset: SUSDS_ADDRESS,
    baseTokenName: 'Yes',
    currentTime: Math.floor(Date.now() / 1000).toString()
  });

  // Find the market with the earliest endTimestamp from public markets
  const nextMarket = responseData?.marketGroups
    ?.flatMap(group => 
      group.markets?.map(market => ({
        ...market,
        marketGroup: { address: group.address } as MarketGroupType
      })) || []
    )
    ?.filter(market => market.public === true) // Filter for public markets
    ?.reduce((earliest, market) => {
      if (!earliest) return market;
      
      const earliestTime = earliest.endTimestamp ? parseInt(earliest.endTimestamp.toString()) : Infinity;
      const marketTime = market.endTimestamp ? parseInt(market.endTimestamp.toString()) : Infinity;
      
      return marketTime < earliestTime ? market : earliest;
    }, null as MarketType | null);

  if (!nextMarket) {
    throw new Error('No active markets found.');
  }

  return nextMarket;
}

// Ask ChatGPT to answer the question
async function getPrediction(question: string): Promise<bigint> {
  if (!process.env.OPENAI_API_KEY) {
    console.log('OpenAI API key not found. Defaulting to "Yes".');
    return parseEther('1');
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const res = await openai.chat.completions.create({
    model: 'gpt-4o-search-preview',
    messages: [
      {
        role: 'system',
        content: 'You are a helpful research assistant that answers questions. You MUST ALWAYS, regardless of your confidence, reply to the question with just "Yes", "No", or a specific number on the final line.'
      },
      {
        role: 'user',
        content: question
      }
    ],
    web_search_options: {
      search_context_size: 'medium'
    },
  });

  const content = res.choices[0].message.content;
  if (typeof content !== 'string') {
    console.error('Invalid response structure from OpenAI API:', res);
    throw new Error('Failed to get a valid response from OpenAI API.');
  }
  console.log(content);

  const answer = content.trim().toLowerCase();

  // If the answer is "yes", return 1e18
  if (answer.includes('yes')) {
    return parseEther('1');
  }

  // If the answer is "no", return 0
  else if (answer.includes('no')) {
    return 0n;
  }
  
  else {
    throw new Error("Couldn't parse a prediction");
  }
}

// Get the desired position size given the answer and a maximum $1 wager
async function getQuote(marketAddress: Address, marketId: bigint, prediction: bigint): Promise<{ positionSize: bigint }> {
  let expectedPriceDecimalString: string;
  if (prediction === 0n) {
    expectedPriceDecimalString = '0.0000009'; // API expects expectedPrice > 0. Use a very small number for "No".
  } else {
    expectedPriceDecimalString = formatEther(prediction); // Convert prediction (scaled by 1e18) to a decimal string (e.g., 10n**18n -> "1.0")
  }

  const quoterUrl = `https://api.sapience.xyz/quoter/${base.id}/${marketAddress}/${marketId}?collateralAvailable=${WAGER_AMOUNT.toString()}&expectedPrice=${expectedPriceDecimalString}`;
  
  const response = await fetch(quoterUrl);
  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`Quoter API request failed with status ${response.status}: ${errorBody}`);
    throw new Error(`Quoter API request failed with status ${response.status}: ${errorBody}`);
  }
  
  const quote = await response.json() as { maxSize: string; };

  const positionSize = BigInt(quote.maxSize); 
  
  return { positionSize };
}

// Approve token transfer and trade
async function trade(marketAddress: Address, marketId: bigint, positionSize: bigint) {
  if (!ETHEREUM_PRIVATE_KEY) {
    throw new Error('Ethereum private key is not set in environment variables.');
  }
  const account = privateKeyToAccount(ETHEREUM_PRIVATE_KEY as `0x${string}`);

  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(),
  });

  const publicClient = createPublicClient({
    chain: base,
    transport: http(),
  });

  // Approve the token spend
  console.log('Approving token spend...');
  const approveHash = await walletClient.writeContract({
    address: SUSDS_ADDRESS,
    abi: erc20Abi,
    functionName: 'approve',
    args: [marketAddress, WAGER_AMOUNT],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });

  // Define deadline for createTraderPosition (1 hour from now)
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 60 * 60);

  // Create the trader position
  console.log('Creating trader position...');
  const tradeHash = await walletClient.writeContract({
    address: marketAddress,
    abi: Foil.abi,
    functionName: 'createTraderPosition',
    args: [marketId, positionSize, WAGER_AMOUNT, deadline],
  });
  await publicClient.waitForTransactionReceipt({ hash: tradeHash });
  console.log();
  
  console.log('Success!');
  console.log(`${base.blockExplorers.default.url}/tx/${tradeHash}`);
}

(async () => {
  const market = await fetchNextClosingMarket();
  console.group('Found an active market...');
  console.log();
  console.log(market.question);
  console.groupEnd();
  console.log();

  console.group('Asking ChatGPT for an answer...');
  console.log();
  const prediction = await getPrediction(market.question!);
  console.groupEnd();
  console.log();

  console.log(`Retrieving a quote for a $1 wager on market outcome "${prediction}"...`);
  console.log();
  const marketGroupAddress = market.marketGroup!.address! as Address;
  const { positionSize } = await getQuote(marketGroupAddress, BigInt(market.marketId), prediction);

  if(ETHEREUM_PRIVATE_KEY){
    console.group(`Submitting trade with a size of ${formatEther(positionSize)}...`);
    console.log();
    await trade(marketGroupAddress, BigInt(market.marketId), positionSize);
    console.groupEnd();
    console.log();
  } else {
    console.log(`Trade Size: ${formatEther(positionSize)}`);
    console.log('Add an Ethereum private key to your .env file to submit trades.');
    console.log();
  }

  console.log('Done!');
})().catch(console.error);