import * as anchor from "@coral-xyz/anchor";
import { ASSOCIATED_PROGRAM_ID } from "@coral-xyz/anchor/dist/cjs/utils/token";
import {
  createAssociatedTokenAccountInstruction,
  createMint,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  getMint,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
} from "@solana/web3.js";

// Initialize the Anchor provider
const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const program = anchor.workspace.Dex as any; // TODO: fix this
const DEFAULT_AIRDROP_SOL = 2;

describe("DEX tests", () => {
  // Test accounts
  let adminWallet: anchor.Wallet;
  let admin: Keypair;
  let dexStatePda: PublicKey;
  let unauthorizedAttacker: Keypair;
  let poolOwner: Keypair;

  // Token variables
  let tokenAMint: PublicKey;
  let tokenBMint: PublicKey;
  let tokenAMintKeypair: Keypair;
  let tokenBMintKeypair: Keypair;
  let poolPda: PublicKey;
  let poolTokenA: PublicKey;
  let poolTokenB: PublicKey;
  let lpTokenMint: PublicKey;

  before(async () => {
    // Setup test accounts
    adminWallet = provider.wallet as anchor.Wallet;
    admin = adminWallet.payer;
    unauthorizedAttacker = Keypair.generate();
    poolOwner = Keypair.generate();

    // Get DEX state PDA
    dexStatePda = PublicKey.findProgramAddressSync(
      [Buffer.from("dex_state"), adminWallet.publicKey.toBuffer()],
      program.programId
    )[0];

    // Airdrop SOL to test accounts
    await airdropIfNeeded(provider.connection, unauthorizedAttacker.publicKey);
    await airdropIfNeeded(provider.connection, poolOwner.publicKey);
  });

  // NOTE: Dex initialization with incorrect Admin Key is failing
  it("Dex initialization with incorrect Admin Key is failing", async () => {
    // Get PDA for unauthorized admin
    const unauthorizedDexStatePda = PublicKey.findProgramAddressSync(
      [Buffer.from("dex_state"), unauthorizedAttacker.publicKey.toBuffer()],
      program.programId
    )[0];

    const initializeAccounts = {
      admin: unauthorizedAttacker.publicKey,
      dexState: unauthorizedDexStatePda,
      systemProgram: anchor.web3.SystemProgram.programId,
    };

    try {
      // Try to initialize DEX with unauthorized admin
      await program.methods
        .initialize(new anchor.BN(10), new anchor.BN(1000))
        .accounts(initializeAccounts)
        .signers([unauthorizedAttacker])
        .rpc();

      throw new Error("Expected transaction to fail, but it succeeded");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("NotAdmin");
    }
  });

  // NOTE: Dex initialization with correct Admin Key
  it("Dex initialization with correct Admin Key", async () => {
    const initializeAccounts = {
      admin: adminWallet.publicKey,
      dexState: dexStatePda,
      systemProgram: anchor.web3.SystemProgram.programId,
    };

    // Initialize DEX with correct admin
    await program.methods
      .initialize(new anchor.BN(10), new anchor.BN(1000))
      .accounts(initializeAccounts)
      .rpc();

    // Verify initialization
    const dexState = await program.account.dexState.fetch(dexStatePda);
    expect(dexState.poolsCount.toNumber()).to.equal(0);
    expect(dexState.admin.toBase58()).to.equal(adminWallet.publicKey.toBase58());
    expect(dexState.feeNumerator.toNumber()).to.equal(10);
    expect(dexState.feeDenominator.toNumber()).to.equal(1000);
  });

  // NOTE: Creating a liquidity pool
  it("Creating a liquidity pool", async () => {
    // Create token mints
    tokenAMintKeypair = Keypair.generate();
    tokenBMintKeypair = Keypair.generate();
    tokenAMint = tokenAMintKeypair.publicKey;
    tokenBMint = tokenBMintKeypair.publicKey;

    // Create mints with 6 decimals
    await createMint(
      provider.connection,
      poolOwner,
      poolOwner.publicKey,
      null,
      6,
      tokenAMintKeypair,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    await createMint(
      provider.connection,
      poolOwner,
      poolOwner.publicKey,
      null,
      6,
      tokenBMintKeypair,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    // Get pool PDA and token accounts
    [poolPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("liquidity_pool"),
        tokenAMint.toBuffer(),
        tokenBMint.toBuffer(),
      ],
      program.programId
    );

    // Generate LP token mint
    const lpTokenMintKeypair = Keypair.generate();
    lpTokenMint = lpTokenMintKeypair.publicKey;

    // Get associated token accounts
    poolTokenA = getAssociatedTokenAddressSync(
      tokenAMint,
      poolPda,
      true,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_PROGRAM_ID
    );

    poolTokenB = getAssociatedTokenAddressSync(
      tokenBMint,
      poolPda,
      true,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_PROGRAM_ID
    );

    const ownerLpToken = getAssociatedTokenAddressSync(
      lpTokenMint,
      poolOwner.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_PROGRAM_ID
    );

    // Create token accounts for pool
    const setupTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        poolOwner.publicKey,
        poolTokenA,
        poolPda,
        tokenAMint,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_PROGRAM_ID
      ),
      createAssociatedTokenAccountInstruction(
        poolOwner.publicKey,
        poolTokenB,
        poolPda,
        tokenBMint,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_PROGRAM_ID
      )
    );

    await provider.sendAndConfirm(setupTx, [poolOwner]);

    const createPoolAccounts = {
      owner: poolOwner.publicKey,
      dexState: dexStatePda,
      tokenAMint,
      tokenBMint,
      pool: poolPda,
      poolTokenA,
      poolTokenB,
      lpTokenMint,
      ownerLpToken,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    };

    // Create the pool
    await program.methods
      .createPool()
      .accounts(createPoolAccounts)
      .signers([poolOwner, lpTokenMintKeypair])
      .rpc();

    // Verify pool creation
    const pool = await program.account.liquidityPool.fetch(poolPda);
    const dexState = await program.account.dexState.fetch(dexStatePda);
    const lpMintInfo = await getMint(
      provider.connection,
      lpTokenMint,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    // Check pool state
    expect(pool.tokenAMint.toBase58()).to.equal(tokenAMint.toBase58());
    expect(pool.tokenBMint.toBase58()).to.equal(tokenBMint.toBase58());
    expect(pool.lpTokenMint.toBase58()).to.equal(lpTokenMint.toBase58());
    expect(pool.totalLiquidity.toNumber()).to.equal(0);
    expect(pool.feeNumerator.toNumber()).to.equal(dexState.feeNumerator.toNumber());
    expect(pool.feeDenominator.toNumber()).to.equal(dexState.feeDenominator.toNumber());
    expect(dexState.poolsCount.toNumber()).to.equal(1);
    expect(lpMintInfo.decimals).to.equal(6);
  });

  // NOTE: Depositing and withdrawing liquidity
  it("Depositing and withdrawing liquidity", async () => {
    // Create user token accounts
    const ownerTokenA = getAssociatedTokenAddressSync(
      tokenAMint,
      poolOwner.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_PROGRAM_ID
    );

    const ownerTokenB = getAssociatedTokenAddressSync(
      tokenBMint,
      poolOwner.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_PROGRAM_ID
    );

    const poolAccount = await program.account.liquidityPool.fetch(poolPda);
    const ownerLpToken = getAssociatedTokenAddressSync(
      poolAccount.lpTokenMint,
      poolOwner.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_PROGRAM_ID
    );

    // Create user token accounts
    const setupTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        poolOwner.publicKey,
        ownerTokenA,
        poolOwner.publicKey,
        tokenAMint,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_PROGRAM_ID
      ),
      createAssociatedTokenAccountInstruction(
        poolOwner.publicKey,
        ownerTokenB,
        poolOwner.publicKey,
        tokenBMint,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_PROGRAM_ID
      )
    );

    await provider.sendAndConfirm(setupTx, [poolOwner]);

    // Mint tokens to user
    const mintTx = new Transaction().add(
      createMintToInstruction(
        tokenAMint,
        ownerTokenA,
        poolOwner.publicKey,
        1000000,  // 1 token with 6 decimals
        [],
        TOKEN_2022_PROGRAM_ID
      ),
      createMintToInstruction(
        tokenBMint,
        ownerTokenB,
        poolOwner.publicKey,
        2000000,  // 2 tokens with 6 decimals
        [],
        TOKEN_2022_PROGRAM_ID
      )
    );

    await provider.sendAndConfirm(mintTx, [poolOwner]);

    // Deposit liquidity
    const tokenAAmount = 500000; // 0.5 tokens
    const tokenBAmount = 1000000; // 1 token

    const depositAccounts = {
      owner: poolOwner.publicKey,
      pool: poolPda,
      tokenAMint,
      tokenBMint,
      poolTokenA,
      poolTokenB,
      lpTokenMint: poolAccount.lpTokenMint,
      userTokenA: ownerTokenA,
      userTokenB: ownerTokenB,
      userLpToken: ownerLpToken,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    };

    await program.methods
      .depositLiquidity(new anchor.BN(tokenAAmount), new anchor.BN(tokenBAmount))
      .accounts(depositAccounts)
      .signers([poolOwner])
      .rpc();

    // Get balances after deposit
    const poolAfterDeposit = await program.account.liquidityPool.fetch(poolPda);
    const poolTokenABalance = await provider.connection.getTokenAccountBalance(poolTokenA);
    const poolTokenBBalance = await provider.connection.getTokenAccountBalance(poolTokenB);
    const ownerLpTokenBalance = await provider.connection.getTokenAccountBalance(ownerLpToken);

    // Withdraw half of LP tokens
    const lpAmountToWithdraw = Math.floor(Number(ownerLpTokenBalance.value.amount) / 2);

    const withdrawAccounts = {
      owner: poolOwner.publicKey,
      pool: poolPda,
      tokenAMint,
      tokenBMint,
      poolTokenA,
      poolTokenB,
      lpTokenMint: poolAccount.lpTokenMint,
      userTokenA: ownerTokenA,
      userTokenB: ownerTokenB,
      userLpToken: ownerLpToken,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    };

    await program.methods
      .withdrawLiquidity(new anchor.BN(lpAmountToWithdraw))
      .accounts(withdrawAccounts)
      .signers([poolOwner])
      .rpc();

    // Get balances after withdrawal
    const poolAfterWithdraw = await program.account.liquidityPool.fetch(poolPda);
    const poolTokenABalanceAfter = await provider.connection.getTokenAccountBalance(poolTokenA);
    const poolTokenBBalanceAfter = await provider.connection.getTokenAccountBalance(poolTokenB);
    const ownerLpTokenBalanceAfter = await provider.connection.getTokenAccountBalance(ownerLpToken);

    // Verify withdrawal
    expect(Number(poolAfterWithdraw.totalLiquidity.toString())).to.be.approximately(
      Number(poolAfterDeposit.totalLiquidity.toString()) - lpAmountToWithdraw,
      1 // Allow for rounding
    );

    expect(Number(ownerLpTokenBalanceAfter.value.amount)).to.be.approximately(
      Number(ownerLpTokenBalance.value.amount) - lpAmountToWithdraw,
      1 // Allow for rounding
    );

    expect(Number(poolTokenABalanceAfter.value.amount)).to.be.approximately(
      Number(poolTokenABalance.value.amount) / 2,
      10 // Allow for rounding
    );

    expect(Number(poolTokenBBalanceAfter.value.amount)).to.be.approximately(
      Number(poolTokenBBalance.value.amount) / 2,
      10 // Allow for rounding
    );
  });

  // NOTE: Swapping tokens
  it("Swapping tokens", async () => {
    // Get token accounts
    const ownerTokenA = getAssociatedTokenAddressSync(
      tokenAMint,
      poolOwner.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_PROGRAM_ID
    );

    const ownerTokenB = getAssociatedTokenAddressSync(
      tokenBMint,
      poolOwner.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_PROGRAM_ID
    );

    // Ensure enough liquidity
    const poolTokenABalance = await provider.connection.getTokenAccountBalance(poolTokenA);
    const poolTokenBBalance = await provider.connection.getTokenAccountBalance(poolTokenB);

    // Add liquidity if needed
    if (
      Number(poolTokenABalance.value.amount) < 100000 ||
      Number(poolTokenBBalance.value.amount) < 100000
    ) {
      // Mint more tokens if needed
      const userTokenABalance = await provider.connection.getTokenAccountBalance(ownerTokenA);
      const userTokenBBalance = await provider.connection.getTokenAccountBalance(ownerTokenB);
      const mintTxs = new Transaction();

      if (Number(userTokenABalance.value.amount) < 500000) {
        mintTxs.add(
          createMintToInstruction(
            tokenAMint,
            ownerTokenA,
            poolOwner.publicKey,
            500000,
            [],
            TOKEN_2022_PROGRAM_ID
          )
        );
      }

      if (Number(userTokenBBalance.value.amount) < 500000) {
        mintTxs.add(
          createMintToInstruction(
            tokenBMint,
            ownerTokenB,
            poolOwner.publicKey,
            500000,
            [],
            TOKEN_2022_PROGRAM_ID
          )
        );
      }

      if (mintTxs.instructions.length > 0) {
        await provider.sendAndConfirm(mintTxs, [poolOwner]);
      }

      // Deposit additional liquidity
      const poolAccount = await program.account.liquidityPool.fetch(poolPda);
      const ownerLpToken = getAssociatedTokenAddressSync(
        poolAccount.lpTokenMint,
        poolOwner.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_PROGRAM_ID
      );

      const additionalDepositAccounts = {
        owner: poolOwner.publicKey,
        pool: poolPda,
        tokenAMint,
        tokenBMint,
        poolTokenA,
        poolTokenB,
        lpTokenMint: poolAccount.lpTokenMint,
        userTokenA: ownerTokenA,
        userTokenB: ownerTokenB,
        userLpToken: ownerLpToken,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      };

      await program.methods
        .depositLiquidity(new anchor.BN(200000), new anchor.BN(400000))
        .accounts(additionalDepositAccounts)
        .signers([poolOwner])
        .rpc();
    }

    // Get pool data before swap
    const poolBeforeSwap = await program.account.liquidityPool.fetch(poolPda);
    const poolTokenABalanceBefore = await provider.connection.getTokenAccountBalance(poolTokenA);
    const poolTokenBBalanceBefore = await provider.connection.getTokenAccountBalance(poolTokenB);
    const ownerTokenABalanceBefore = await provider.connection.getTokenAccountBalance(ownerTokenA);
    const ownerTokenBBalanceBefore = await provider.connection.getTokenAccountBalance(ownerTokenB);

    // Calculate expected output with fee
    const inputAmount = 50000; // 0.05 token A
    const reserveA = Number(poolTokenABalanceBefore.value.amount);
    const reserveB = Number(poolTokenBBalanceBefore.value.amount);
    const feeNumerator = poolBeforeSwap.feeNumerator.toNumber();
    const feeDenominator = poolBeforeSwap.feeDenominator.toNumber();
    const inputWithFee = inputAmount - (inputAmount * feeNumerator / feeDenominator);
    const expectedOutput = Math.floor((reserveB * inputWithFee) / (reserveA + inputWithFee));
    const minimumOutputAmount = Math.floor(expectedOutput * 0.99); // 1% slippage

    const swapAccounts = {
      owner: poolOwner.publicKey,
      pool: poolPda,
      sourceMint: tokenAMint,
      destinationMint: tokenBMint,
      poolTokenA,
      poolTokenB,
      userSourceToken: ownerTokenA,
      userDestinationToken: ownerTokenB,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    };

    // Execute swap A to B
    await program.methods
      .swap(
        new anchor.BN(inputAmount),
        new anchor.BN(minimumOutputAmount)
      )
      .accounts(swapAccounts)
      .signers([poolOwner])
      .rpc();

    // Get balances after swap
    const poolTokenABalanceAfter = await provider.connection.getTokenAccountBalance(poolTokenA);
    const poolTokenBBalanceAfter = await provider.connection.getTokenAccountBalance(poolTokenB);
    const ownerTokenABalanceAfter = await provider.connection.getTokenAccountBalance(ownerTokenA);
    const ownerTokenBBalanceAfter = await provider.connection.getTokenAccountBalance(ownerTokenB);

    // Verify swap
    const actualOutputAmount = Number(ownerTokenBBalanceAfter.value.amount) - Number(ownerTokenBBalanceBefore.value.amount);

    expect(
      Number(poolTokenABalanceAfter.value.amount) - Number(poolTokenABalanceBefore.value.amount)
    ).to.equal(inputAmount);

    expect(
      Number(poolTokenBBalanceBefore.value.amount) - Number(poolTokenBBalanceAfter.value.amount)
    ).to.equal(actualOutputAmount);

    expect(
      Number(ownerTokenABalanceBefore.value.amount) - Number(ownerTokenABalanceAfter.value.amount)
    ).to.equal(inputAmount);

    expect(actualOutputAmount).to.be.at.least(minimumOutputAmount);

    // Verify constant product formula holds (with fee increase)
    const productBefore = Number(poolTokenABalanceBefore.value.amount) * Number(poolTokenBBalanceBefore.value.amount);
    const productAfter = Number(poolTokenABalanceAfter.value.amount) * Number(poolTokenBBalanceAfter.value.amount);
    expect(productAfter).to.be.greaterThan(productBefore * 0.99);

    // Test reverse swap (B to A)
    const reverseInputAmount = 30000; // 0.03 token B
    const reverseReserveA = Number(poolTokenABalanceAfter.value.amount);
    const reverseReserveB = Number(poolTokenBBalanceAfter.value.amount);
    const reverseInputWithFee = reverseInputAmount - (reverseInputAmount * feeNumerator / feeDenominator);
    const reverseExpectedOutput = Math.floor((reverseReserveA * reverseInputWithFee) / (reverseReserveB + reverseInputWithFee));
    const reverseMinimumOutput = Math.floor(reverseExpectedOutput * 0.99);

    const reverseSwapAccounts = {
      owner: poolOwner.publicKey,
      pool: poolPda,
      sourceMint: tokenBMint,
      destinationMint: tokenAMint,
      poolTokenA,
      poolTokenB,
      userSourceToken: ownerTokenB,
      userDestinationToken: ownerTokenA,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    };

    // Execute reverse swap
    await program.methods
      .swap(
        new anchor.BN(reverseInputAmount),
        new anchor.BN(reverseMinimumOutput)
      )
      .accounts(reverseSwapAccounts)
      .signers([poolOwner])
      .rpc();

    // Get final balances
    const finalPoolTokenABalance = await provider.connection.getTokenAccountBalance(poolTokenA);
    const finalPoolTokenBBalance = await provider.connection.getTokenAccountBalance(poolTokenB);
    const finalOwnerTokenABalance = await provider.connection.getTokenAccountBalance(ownerTokenA);

    // Verify reverse swap
    const reverseActualOutput = Number(finalOwnerTokenABalance.value.amount) - Number(ownerTokenABalanceAfter.value.amount);

    expect(
      Number(finalPoolTokenBBalance.value.amount) - Number(poolTokenBBalanceAfter.value.amount)
    ).to.equal(reverseInputAmount);

    expect(
      Number(poolTokenABalanceAfter.value.amount) - Number(finalPoolTokenABalance.value.amount)
    ).to.equal(reverseActualOutput);

    expect(reverseActualOutput).to.be.at.least(reverseMinimumOutput);
  });

  // NOTE: Fee calculation and distribution
  it("Fee calculation and distribution", async () => {
    // Get token accounts
    const ownerTokenA = getAssociatedTokenAddressSync(
      tokenAMint,
      poolOwner.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_PROGRAM_ID
    );

    const ownerTokenB = getAssociatedTokenAddressSync(
      tokenBMint,
      poolOwner.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_PROGRAM_ID
    );

    // Get pool data before swap
    const poolBeforeSwap = await program.account.liquidityPool.fetch(poolPda);
    const poolTokenABalanceBefore = await provider.connection.getTokenAccountBalance(poolTokenA);
    const poolTokenBBalanceBefore = await provider.connection.getTokenAccountBalance(poolTokenB);
    const reserveABefore = Number(poolTokenABalanceBefore.value.amount);
    const reserveBBefore = Number(poolTokenBBalanceBefore.value.amount);
    const productBefore = reserveABefore * reserveBBefore;

    // Calculate expected fee
    const inputAmount = 100000; // 0.1 token A
    const feeNumerator = poolBeforeSwap.feeNumerator.toNumber();
    const feeDenominator = poolBeforeSwap.feeDenominator.toNumber();
    const expectedFee = inputAmount * feeNumerator / feeDenominator;
    const inputWithFee = inputAmount - expectedFee;

    // Calculate expected output using constant product formula
    const expectedOutput = Math.floor((reserveBBefore * inputWithFee) / (reserveABefore + inputWithFee));
    const minimumOutputAmount = Math.floor(expectedOutput * 0.99); // 1% slippage

    // Execute swap to generate fee
    const swapAccounts = {
      owner: poolOwner.publicKey,
      pool: poolPda,
      sourceMint: tokenAMint,
      destinationMint: tokenBMint,
      poolTokenA,
      poolTokenB,
      userSourceToken: ownerTokenA,
      userDestinationToken: ownerTokenB,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    };

    await program.methods
      .swap(
        new anchor.BN(inputAmount),
        new anchor.BN(minimumOutputAmount)
      )
      .accounts(swapAccounts)
      .signers([poolOwner])
      .rpc();

    // Get balances after swap
    const poolTokenABalanceAfter = await provider.connection.getTokenAccountBalance(poolTokenA);
    const poolTokenBBalanceAfter = await provider.connection.getTokenAccountBalance(poolTokenB);
    const reserveAAfter = Number(poolTokenABalanceAfter.value.amount);
    const reserveBAfter = Number(poolTokenBBalanceAfter.value.amount);
    const productAfter = reserveAAfter * reserveBAfter;

    // Verify fee was collected (product has increased)
    expect(productAfter).to.be.greaterThan(productBefore);

    // Calculate actual fee collected based on constant product formula
    const actualFeeCollected = (productAfter / productBefore - 1) * 100; // as percentage

    // Fee should be close to the expected fee percentage
    const expectedFeePercentage = (feeNumerator / feeDenominator) * 100;
    expect(actualFeeCollected).to.be.approximately(expectedFeePercentage, 0.5);
  });

  // NOTE: Slippage protection
  it("Slippage protection prevents unfavorable trades", async () => {
    // Get token accounts
    const ownerTokenA = getAssociatedTokenAddressSync(
      tokenAMint,
      poolOwner.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_PROGRAM_ID
    );

    const ownerTokenB = getAssociatedTokenAddressSync(
      tokenBMint,
      poolOwner.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_PROGRAM_ID
    );

    // Get pool data
    const poolData = await program.account.liquidityPool.fetch(poolPda);
    const poolTokenABalance = await provider.connection.getTokenAccountBalance(poolTokenA);
    const poolTokenBBalance = await provider.connection.getTokenAccountBalance(poolTokenB);
    const reserveA = Number(poolTokenABalance.value.amount);
    const reserveB = Number(poolTokenBBalance.value.amount);

    // Calculate expected output with fee
    const inputAmount = 50000; // 0.05 token A
    const feeNumerator = poolData.feeNumerator.toNumber();
    const feeDenominator = poolData.feeDenominator.toNumber();
    const inputWithFee = inputAmount - (inputAmount * feeNumerator / feeDenominator);
    const expectedOutput = Math.floor((reserveB * inputWithFee) / (reserveA + inputWithFee));

    // Set a minimum output amount higher than possible (unrealistic slippage tolerance)
    const unrealisticMinimumOutput = expectedOutput * 1.5; // 50% more than possible

    const swapAccounts = {
      owner: poolOwner.publicKey,
      pool: poolPda,
      sourceMint: tokenAMint,
      destinationMint: tokenBMint,
      poolTokenA,
      poolTokenB,
      userSourceToken: ownerTokenA,
      userDestinationToken: ownerTokenB,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    };

    // Attempt swap with unrealistic minimum output - should fail
    try {
      await program.methods
        .swap(
          new anchor.BN(inputAmount),
          new anchor.BN(unrealisticMinimumOutput)
        )
        .accounts(swapAccounts)
        .signers([poolOwner])
        .rpc();

      throw new Error("Transaction should have failed due to slippage protection");
    } catch (err: any) {
      // Verify it's the right error (SlippageExceeded)
      expect(err.error.errorCode.code).to.equal("SlippageExceeded");
    }
  });

  // NOTE: Price manipulation resistance
  it("Resists price manipulation attacks", async () => {
    // Setup a new pool with balanced liquidity
    const manipulatorKeypair = Keypair.generate();
    await airdropIfNeeded(provider.connection, manipulatorKeypair.publicKey);

    // Create new token mints for this test
    const newTokenAMintKeypair = Keypair.generate();
    const newTokenBMintKeypair = Keypair.generate();
    const newTokenAMint = newTokenAMintKeypair.publicKey;
    const newTokenBMint = newTokenBMintKeypair.publicKey;

    // Create mints with 6 decimals
    await createMint(
      provider.connection,
      manipulatorKeypair,
      manipulatorKeypair.publicKey,
      null,
      6,
      newTokenAMintKeypair,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    await createMint(
      provider.connection,
      manipulatorKeypair,
      manipulatorKeypair.publicKey,
      null,
      6,
      newTokenBMintKeypair,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    // Get pool PDA and token accounts
    const [newPoolPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("liquidity_pool"),
        newTokenAMint.toBuffer(),
        newTokenBMint.toBuffer(),
      ],
      program.programId
    );

    // Generate LP token mint
    const newLpTokenMintKeypair = Keypair.generate();
    const newLpTokenMint = newLpTokenMintKeypair.publicKey;

    // Get associated token accounts
    const newPoolTokenA = getAssociatedTokenAddressSync(
      newTokenAMint,
      newPoolPda,
      true,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_PROGRAM_ID
    );

    const newPoolTokenB = getAssociatedTokenAddressSync(
      newTokenBMint,
      newPoolPda,
      true,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_PROGRAM_ID
    );

    const manipulatorTokenA = getAssociatedTokenAddressSync(
      newTokenAMint,
      manipulatorKeypair.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_PROGRAM_ID
    );

    const manipulatorTokenB = getAssociatedTokenAddressSync(
      newTokenBMint,
      manipulatorKeypair.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_PROGRAM_ID
    );

    const manipulatorLpToken = getAssociatedTokenAddressSync(
      newLpTokenMint,
      manipulatorKeypair.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_PROGRAM_ID
    );

    // Setup accounts
    const setupTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        manipulatorKeypair.publicKey,
        manipulatorTokenA,
        manipulatorKeypair.publicKey,
        newTokenAMint,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_PROGRAM_ID
      ),
      createAssociatedTokenAccountInstruction(
        manipulatorKeypair.publicKey,
        manipulatorTokenB,
        manipulatorKeypair.publicKey,
        newTokenBMint,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_PROGRAM_ID
      ),
      createAssociatedTokenAccountInstruction(
        manipulatorKeypair.publicKey,
        newPoolTokenA,
        newPoolPda,
        newTokenAMint,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_PROGRAM_ID
      ),
      createAssociatedTokenAccountInstruction(
        manipulatorKeypair.publicKey,
        newPoolTokenB,
        newPoolPda,
        newTokenBMint,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_PROGRAM_ID
      )
    );

    await provider.sendAndConfirm(setupTx, [manipulatorKeypair]);

    // Mint tokens to attacker
    const mintAmount = 10000000; // 10 tokens
    const mintTx = new Transaction().add(
      createMintToInstruction(
        newTokenAMint,
        manipulatorTokenA,
        manipulatorKeypair.publicKey,
        mintAmount,
        [],
        TOKEN_2022_PROGRAM_ID
      ),
      createMintToInstruction(
        newTokenBMint,
        manipulatorTokenB,
        manipulatorKeypair.publicKey,
        mintAmount,
        [],
        TOKEN_2022_PROGRAM_ID
      )
    );

    await provider.sendAndConfirm(mintTx, [manipulatorKeypair]);

    // Create pool
    const createPoolAccounts = {
      owner: manipulatorKeypair.publicKey,
      dexState: dexStatePda,
      tokenAMint: newTokenAMint,
      tokenBMint: newTokenBMint,
      pool: newPoolPda,
      poolTokenA: newPoolTokenA,
      poolTokenB: newPoolTokenB,
      lpTokenMint: newLpTokenMint,
      ownerLpToken: manipulatorLpToken,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    };

    await program.methods
      .createPool()
      .accounts(createPoolAccounts)
      .signers([manipulatorKeypair, newLpTokenMintKeypair])
      .rpc();

    // Add initial balanced liquidity
    const initialLiquidityAmount = 1000000; // 1 token of each

    const depositAccounts = {
      owner: manipulatorKeypair.publicKey,
      pool: newPoolPda,
      tokenAMint: newTokenAMint,
      tokenBMint: newTokenBMint,
      poolTokenA: newPoolTokenA,
      poolTokenB: newPoolTokenB,
      lpTokenMint: newLpTokenMint,
      userTokenA: manipulatorTokenA,
      userTokenB: manipulatorTokenB,
      userLpToken: manipulatorLpToken,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    };

    await program.methods
      .depositLiquidity(
        new anchor.BN(initialLiquidityAmount),
        new anchor.BN(initialLiquidityAmount)
      )
      .accounts(depositAccounts)
      .signers([manipulatorKeypair])
      .rpc();

    // Attempt manipulation: Add large amount of token A to skew the price
    const skewAmount = 8000000; // 8 tokens

    const swapAccounts = {
      owner: manipulatorKeypair.publicKey,
      pool: newPoolPda,
      sourceMint: newTokenAMint,
      destinationMint: newTokenBMint,
      poolTokenA: newPoolTokenA,
      poolTokenB: newPoolTokenB,
      userSourceToken: manipulatorTokenA,
      userDestinationToken: manipulatorTokenB,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    };

    // Get pool data before manipulation
    const poolDataBefore = await program.account.liquidityPool.fetch(newPoolPda);
    const poolTokenABalanceBefore = await provider.connection.getTokenAccountBalance(newPoolTokenA);
    const poolTokenBBalanceBefore = await provider.connection.getTokenAccountBalance(newPoolTokenB);

    // Calculate expected output for manipulation
    const reserveA = Number(poolTokenABalanceBefore.value.amount);
    const reserveB = Number(poolTokenBBalanceBefore.value.amount);
    const feeNumerator = poolDataBefore.feeNumerator.toNumber();
    const feeDenominator = poolDataBefore.feeDenominator.toNumber();
    const manipulationWithFee = skewAmount - (skewAmount * feeNumerator / feeDenominator);
    const expectedManipulationOutput = Math.floor((reserveB * manipulationWithFee) / (reserveA + manipulationWithFee));
    const minimumOutput = Math.floor(expectedManipulationOutput * 0.99); // 1% slippage

    // Execute manipulation swap (token A to token B)
    await program.methods
      .swap(
        new anchor.BN(skewAmount),
        new anchor.BN(minimumOutput)
      )
      .accounts(swapAccounts)
      .signers([manipulatorKeypair])
      .rpc();

    // Get balances after manipulation
    const poolTokenABalanceAfterManipulation = await provider.connection.getTokenAccountBalance(newPoolTokenA);
    const poolTokenBBalanceAfterManipulation = await provider.connection.getTokenAccountBalance(newPoolTokenB);
    const reserveAAfterManipulation = Number(poolTokenABalanceAfterManipulation.value.amount);
    const reserveBAfterManipulation = Number(poolTokenBBalanceAfterManipulation.value.amount);

    // Verify price was manipulated (ratio changed significantly)
    const initialRatio = reserveA / reserveB;
    const manipulatedRatio = reserveAAfterManipulation / reserveBAfterManipulation;
    expect(manipulatedRatio).to.be.greaterThan(initialRatio * 2); // Price changed by at least 2x

    // Reverse swap to attempt profit (token B to token A)
    const reverseSwapAccounts = {
      owner: manipulatorKeypair.publicKey,
      pool: newPoolPda,
      sourceMint: newTokenBMint,
      destinationMint: newTokenAMint,
      poolTokenA: newPoolTokenA,
      poolTokenB: newPoolTokenB,
      userSourceToken: manipulatorTokenB,
      userDestinationToken: manipulatorTokenA,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    };

    // Check token B balance of manipulator
    const manipulatorTokenBBalanceAfterManipulation = await provider.connection.getTokenAccountBalance(manipulatorTokenB);
    const manipulatorTokenABalanceAfterManipulation = await provider.connection.getTokenAccountBalance(manipulatorTokenA);

    // Swap all token B back to token A
    const reverseAmount = Number(manipulatorTokenBBalanceAfterManipulation.value.amount);
    const reverseWithFee = reverseAmount - (reverseAmount * feeNumerator / feeDenominator);
    const expectedReverseOutput = Math.floor((reserveAAfterManipulation * reverseWithFee) / (reserveBAfterManipulation + reverseWithFee));
    const reverseMinimumOutput = Math.floor(expectedReverseOutput * 0.99); // 1% slippage

    await program.methods
      .swap(
        new anchor.BN(reverseAmount),
        new anchor.BN(reverseMinimumOutput)
      )
      .accounts(reverseSwapAccounts)
      .signers([manipulatorKeypair])
      .rpc();

    // Check final balances
    const manipulatorTokenABalanceAfterReverseSwap = await provider.connection.getTokenAccountBalance(manipulatorTokenA);
    const manipulatorTokenBBalanceAfterReverseSwap = await provider.connection.getTokenAccountBalance(manipulatorTokenB);

    // Calculate total tokens before and after (in token A units)
    const initialTokensA = mintAmount;
    const finalTokensA = Number(manipulatorTokenABalanceAfterReverseSwap.value.amount);

    // Verify that sandwich attack lost money due to fees
    expect(finalTokensA).to.be.lessThan(initialTokensA);

    // Calculate fee loss percentage
    const feeLossPercentage = ((initialTokensA - finalTokensA) / initialTokensA) * 100;

    // Expected fee loss should be around twice the fee percentage (for two swaps)
    const expectedFeeLoss = 2 * (feeNumerator / feeDenominator) * 100;
    expect(feeLossPercentage).to.be.approximately(expectedFeeLoss, 1);
  });

  // NOTE: Multiple token ratio deposits
  it("Handles different deposit ratios correctly", async () => {
    // Create a new pool for this test
    const testUserKeypair = Keypair.generate();
    await airdropIfNeeded(provider.connection, testUserKeypair.publicKey);

    // Create new token mints
    const testTokenAMintKeypair = Keypair.generate();
    const testTokenBMintKeypair = Keypair.generate();
    const testTokenAMint = testTokenAMintKeypair.publicKey;
    const testTokenBMint = testTokenBMintKeypair.publicKey;

    // Create mints with 6 decimals
    await createMint(
      provider.connection,
      testUserKeypair,
      testUserKeypair.publicKey,
      null,
      6,
      testTokenAMintKeypair,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    await createMint(
      provider.connection,
      testUserKeypair,
      testUserKeypair.publicKey,
      null,
      6,
      testTokenBMintKeypair,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    // Get pool PDA and token accounts
    const [testPoolPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("liquidity_pool"),
        testTokenAMint.toBuffer(),
        testTokenBMint.toBuffer(),
      ],
      program.programId
    );

    // Generate LP token mint
    const testLpTokenMintKeypair = Keypair.generate();
    const testLpTokenMint = testLpTokenMintKeypair.publicKey;

    // Get associated token accounts
    const testPoolTokenA = getAssociatedTokenAddressSync(
      testTokenAMint,
      testPoolPda,
      true,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_PROGRAM_ID
    );

    const testPoolTokenB = getAssociatedTokenAddressSync(
      testTokenBMint,
      testPoolPda,
      true,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_PROGRAM_ID
    );

    const testUserTokenA = getAssociatedTokenAddressSync(
      testTokenAMint,
      testUserKeypair.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_PROGRAM_ID
    );

    const testUserTokenB = getAssociatedTokenAddressSync(
      testTokenBMint,
      testUserKeypair.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_PROGRAM_ID
    );

    const testUserLpToken = getAssociatedTokenAddressSync(
      testLpTokenMint,
      testUserKeypair.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_PROGRAM_ID
    );

    // Setup accounts
    const setupTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        testUserKeypair.publicKey,
        testUserTokenA,
        testUserKeypair.publicKey,
        testTokenAMint,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_PROGRAM_ID
      ),
      createAssociatedTokenAccountInstruction(
        testUserKeypair.publicKey,
        testUserTokenB,
        testUserKeypair.publicKey,
        testTokenBMint,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_PROGRAM_ID
      ),
      createAssociatedTokenAccountInstruction(
        testUserKeypair.publicKey,
        testPoolTokenA,
        testPoolPda,
        testTokenAMint,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_PROGRAM_ID
      ),
      createAssociatedTokenAccountInstruction(
        testUserKeypair.publicKey,
        testPoolTokenB,
        testPoolPda,
        testTokenBMint,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_PROGRAM_ID
      )
    );

    await provider.sendAndConfirm(setupTx, [testUserKeypair]);

    // Mint tokens to user
    const mintAmount = 10000000; // 10 tokens
    const mintTx = new Transaction().add(
      createMintToInstruction(
        testTokenAMint,
        testUserTokenA,
        testUserKeypair.publicKey,
        mintAmount,
        [],
        TOKEN_2022_PROGRAM_ID
      ),
      createMintToInstruction(
        testTokenBMint,
        testUserTokenB,
        testUserKeypair.publicKey,
        mintAmount,
        [],
        TOKEN_2022_PROGRAM_ID
      )
    );

    await provider.sendAndConfirm(mintTx, [testUserKeypair]);

    // Create pool
    const createPoolAccounts = {
      owner: testUserKeypair.publicKey,
      dexState: dexStatePda,
      tokenAMint: testTokenAMint,
      tokenBMint: testTokenBMint,
      pool: testPoolPda,
      poolTokenA: testPoolTokenA,
      poolTokenB: testPoolTokenB,
      lpTokenMint: testLpTokenMint,
      ownerLpToken: testUserLpToken,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    };

    await program.methods
      .createPool()
      .accounts(createPoolAccounts)
      .signers([testUserKeypair, testLpTokenMintKeypair])
      .rpc();

    // Case 1: Balanced deposit (1:1 ratio)
    const balancedAmount = 1000000; // 1 token of each

    const depositAccounts = {
      owner: testUserKeypair.publicKey,
      pool: testPoolPda,
      tokenAMint: testTokenAMint,
      tokenBMint: testTokenBMint,
      poolTokenA: testPoolTokenA,
      poolTokenB: testPoolTokenB,
      lpTokenMint: testLpTokenMint,
      userTokenA: testUserTokenA,
      userTokenB: testUserTokenB,
      userLpToken: testUserLpToken,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    };

    await program.methods
      .depositLiquidity(
        new anchor.BN(balancedAmount),
        new anchor.BN(balancedAmount)
      )
      .accounts(depositAccounts)
      .signers([testUserKeypair])
      .rpc();

    // Get LP token balance after balanced deposit
    const balancedLpTokenBalance = await provider.connection.getTokenAccountBalance(testUserLpToken);
    const balancedLpAmount = Number(balancedLpTokenBalance.value.amount);

    // Case 2: Imbalanced deposit (2:1 ratio)
    const imbalancedAmountA = 2000000; // 2 tokens
    const imbalancedAmountB = 1000000; // 1 token

    await program.methods
      .depositLiquidity(
        new anchor.BN(imbalancedAmountA),
        new anchor.BN(imbalancedAmountB)
      )
      .accounts(depositAccounts)
      .signers([testUserKeypair])
      .rpc();

    // Get LP token balance after imbalanced deposit
    const imbalancedLpTokenBalance = await provider.connection.getTokenAccountBalance(testUserLpToken);
    const totalLpAmount = Number(imbalancedLpTokenBalance.value.amount);
    const imbalancedLpAmount = totalLpAmount - balancedLpAmount;

    // The second deposit has double token A but same token B
    // So it should receive less than double the LP tokens of the first deposit
    // Verify effective exchange rate was maintained (not exactly 2x LP tokens)
    expect(imbalancedLpAmount).to.be.lessThan(balancedLpAmount * 2);

    // Calc expected tokens
    const poolBalanceBeforeImbalanced = await provider.connection.getTokenAccountBalance(testPoolTokenA);
    const poolBalanceBeforeImbalancedAmount = Number(poolBalanceBeforeImbalanced.value.amount) - balancedAmount;

    // Expected LP = sqrt(tokenAAmount * tokenBAmount)
    const expectedImbalancedLpAmount = Math.floor(Math.sqrt(imbalancedAmountA * imbalancedAmountB) *
      (balancedLpAmount / Math.sqrt(balancedAmount * balancedAmount)));

    // Verify LP amount is close to expected (within 1% margin due to rounding)
    expect(imbalancedLpAmount).to.be.approximately(expectedImbalancedLpAmount, expectedImbalancedLpAmount * 0.01);
  });

});

/**
 * Airdrops SOL to a given public key if the balance is below a specified threshold.
 */
async function airdropIfNeeded(
  connection: Connection,
  publicKey: PublicKey,
  minBalanceInSol: number = DEFAULT_AIRDROP_SOL
): Promise<void> {
  const currentBalance = await connection.getBalance(publicKey);
  const currentBalanceInSol = currentBalance / LAMPORTS_PER_SOL;

  if (currentBalanceInSol < minBalanceInSol) {
    const requiredAirdrop = minBalanceInSol - currentBalanceInSol;
    const signature = await connection.requestAirdrop(
      publicKey,
      requiredAirdrop * LAMPORTS_PER_SOL
    );

    const latestBlockhash = await connection.getLatestBlockhash();
    await connection.confirmTransaction({
      signature,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    });
  }
}
