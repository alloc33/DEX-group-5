// Migrations are an early feature. Currently, they're nothing more than this
// single deploy script that's invoked from the CLI, injecting a provider
// configured from the workspace's Anchor.toml.

import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

module.exports = async function (provider: anchor.AnchorProvider) {
  // Configure client to use the provider.
  anchor.setProvider(provider);

  // Get program instance
  const program = anchor.workspace.Dex as any; // TODO: fix this

  // Get admin wallet
  const adminWallet = provider.wallet;

  // Get DEX state PDA
  const dexStatePda = PublicKey.findProgramAddressSync(
    [Buffer.from("dex_state"), adminWallet.publicKey.toBuffer()],
    program.programId
  )[0];

  // Initialize fee parameters
  const feeNumerator = 10; // 1% fee (10/1000)
  const feeDenominator = 1000;

  console.log("Initializing DEX with admin:", adminWallet.publicKey.toBase58());
  console.log("DEX state PDA:", dexStatePda.toBase58());
  console.log(`Setting fee to ${feeNumerator}/${feeDenominator} (${feeNumerator / feeDenominator * 100}%)`);

  try {
    // Initialize DEX
    const tx = await program.methods
      .initialize(new anchor.BN(feeNumerator), new anchor.BN(feeDenominator))
      .accounts({
        admin: adminWallet.publicKey,
        dexState: dexStatePda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    console.log("DEX initialized successfully!");
    console.log("Transaction signature:", tx);

    // Fetch and display DEX state
    const dexState = await program.account.dexState.fetch(dexStatePda);
    console.log("DEX State:");
    console.log("  Admin:", dexState.admin.toBase58());
    console.log("  Pools Count:", dexState.poolsCount.toString());
    console.log(`  Fee: ${dexState.feeNumerator.toString()}/${dexState.feeDenominator.toString()}`);

  } catch (error) {
    if (error.message.includes("already in use")) {
      console.log("DEX is already initialized. Fetching current state...");

      // Fetch and display DEX state
      const dexState = await program.account.dexState.fetch(dexStatePda);
      console.log("DEX State:");
      console.log("  Admin:", dexState.admin.toBase58());
      console.log("  Pools Count:", dexState.poolsCount.toString());
      console.log(`  Fee: ${dexState.feeNumerator.toString()}/${dexState.feeDenominator.toString()}`);
    } else {
      console.error("Error during DEX initialization:", error);
    }
  }
};
