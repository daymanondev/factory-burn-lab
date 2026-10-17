# 04 — Install `factory-burn-lab` on trial & desktop homes and run live `Scout pool`

Status: done
Blocked by: 03

## Scope

1. Register `/Users/andrewpham/Documents/code/self-project/factory-burn-lab` in `~/.paseo-factory` and `~/.paseo` plugin configs alongside `paseo-factory`.
2. Run a live `Scout pool` pass against the OpenCode free models (`glm-5.3-flash-free`, `deepseek-v4.1-flash-free`, `mimo-v2.6-flash-free`, `nemotron-3-ultra-free`, `nemotron-3.5-lightning-free`, `nemotron-3.5-super-vl-free`, `beam-free`, `longcat-2.5-preview-free`, `space-bunny-free`, `big-pickle`) to populate `free-pool.json` with empirical latency, tool-call, `Gate`, and `Citation gate` scores.
3. Verify that `burn.snapshot` renders the live `Free pool`, active `Project`s, and `Upstream issue` `#01` cleanly.

## Comments

- Resolved on `feat/v0.0.1-burn-lab` (`7213ad5` + `c39ee3d`): registered `factory-burn-lab` in `~/.paseo-factory/config.json` and `~/.paseo/config.json`, executed live `Scout pool` and `OSS Lab` runs against the OpenCode free pool, and verified `burn.snapshot` renders the live state cleanly.
