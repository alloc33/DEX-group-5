#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;

pub mod instructions;
pub use instructions::*;

declare_id!("Ge4hd4p2D7Y5D9hZCabgXCGk6zpgPbHNC7fv2gsWAZrX");

/// This key is used to authenticate administrative actions within the governance contract.
pub const ADMIN_PUBKEY: Pubkey = pubkey!("E88MCgENj4uksz3QX9DUYRKqM8sJfqHGxCueWDnTPDep");

// This module defines the main instruction handlers for the DEX program
// Each function corresponds to a different instruction that can be invoked
#[program]
pub mod dex {
    use super::*;

    // Initializes the DEX with the specified fee structure
    // fee_numerator/fee_denominator represents the percentage fee (e.g., 10/1000 = 1%)
    pub fn initialize(
        ctx: Context<Initialize>,
        fee_numerator: u64,
        fee_denominator: u64,
    ) -> Result<()> {
        instructions::initialize_dex(ctx, fee_numerator, fee_denominator)
    }

    // Creates a new liquidity pool for a token pair
    // The pool is identified by the token A and token B mints
    pub fn create_pool(ctx: Context<CreatePool>) -> Result<()> {
        instructions::create_liquidity_pool(ctx)
    }

    // Adds liquidity to an existing pool
    // Deposits specified amounts of both tokens and mints LP tokens in return
    pub fn deposit_liquidity(
        ctx: Context<DepositLiquidity>,
        token_a_amount: u64,
        token_b_amount: u64,
    ) -> Result<()> {
        instructions::perform_liquidity_deposit(ctx, token_a_amount, token_b_amount)
    }

    // Removes liquidity from a pool by burning LP tokens
    // Returns both tokens to the user proportional to their share
    pub fn withdraw_liquidity(ctx: Context<WithdrawLiquidity>, lp_amount: u64) -> Result<()> {
        instructions::perform_liquidity_withdrawal(ctx, lp_amount)
    }

    // Swaps between the two tokens in a pool
    // Uses constant product formula (x*y=k) to determine exchange rate
    pub fn swap(ctx: Context<Swap>) -> Result<()> {
        instructions::swap_tokens(ctx)
    }
}

/// Defines custom error codes for the DEX program.
#[error_code]
pub enum DexError {
    // Triggered when a non-admin attempts an admin-only action (dex initialization).
    #[msg("DEX should be initialized by admin.")]
    NotAdmin,
    // Triggered when the fee numerator is greater than or equal to the fee denominator.
    #[msg("Invalid fees.")]
    InvalidFees,
    // Triggered when liquidity is insufficient for an operation
    #[msg("Insufficient liquidity.")]
    InsufficientLiquidity,
}
