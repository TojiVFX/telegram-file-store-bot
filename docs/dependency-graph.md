# Module Dependency Graph

This document details the architectural module dependency graph for the Telegram File Store Bot, organized into a strict 5-layer directed acyclic graph (DAG).

## Layer Hierarchy Overview

```mermaid
flowchart TD
  subgraph Layer5["Layer 5: Application & Entry Points"]
    server["server.js"]
    app["app.js"]
    routes["routes/telegram.js"]
  end

  subgraph Layer4["Layer 4: Controllers & Command Handlers"]
    cmdStart["commands/start.js"]
    cmdAdmin["commands/admin.js"]
    cmdUser["commands/user.js"]
    cbUser["callbacks/user-callbacks.js"]
    cbAdmin["callbacks/admin-callbacks.js"]
    cbAdminModules["callbacks/admin/*.js (10 modules)"]
  end

  subgraph Layer3["Layer 3: Storage & Protocol Aggregates"]
    filestore["filestore.js"]
    botUsers["bot-users.js"]
    phoenix["phoenix-protocol.js"]
  end

  subgraph Layer2["Layer 2: Domain Services"]
    channelHelpers["channel-helpers.js"]
    forceSub["force-subscribe.js"]
    uiBuilders["ui-builders.js"]
    delivery["delivery.js"]
    diagnostics["diagnostics.js"]
    backup["backup.js"]
    ghostFleet["ghost-fleet.js"]
  end

  subgraph Layer1["Layer 1: Primitives & Infrastructure"]
    auth["auth.js"]
    botCommon["bot-common.js"]
    botLogs["bot-logs.js"]
    stealth["stealth-engine.js"]
    antiScraper["anti-scraper.js"]
    envValidator["env-validator.js"]
    memoryCleaner["memory-cleaner.js"]
  end

  Layer5 --> Layer4
  Layer5 --> Layer3
  Layer5 --> Layer2
  Layer5 --> Layer1

  Layer4 --> Layer3
  Layer4 --> Layer2
  Layer4 --> Layer1

  Layer3 --> Layer2
  Layer3 --> Layer1

  Layer2 --> Layer1
```

---

## Architectural Principles & Rules

1. **Strict Upward/Downward Layering**:
   - Lower layers **never** import higher layers.
   - Cross-module communication between peers within the same layer is minimized and strictly acyclic.

2. **Decoupling Key Cycles**:
   - **`auth.js` vs `bot-users.js`**: `getAdminIds`, `getAdminId`, `isAdmin`, and `resetAdminCache` reside in `auth.js` (Layer 1). `bot-users.js` (Layer 3) imports and re-exports them for backward compatibility without creating an inverse cycle back to `channel-helpers.js`.
   - **`bot-common.js` Primitives**: Low-level Telegram API primitives (`copyMessage`, `forwardMessage`) reside in `bot-common.js` (Layer 1), allowing `ghost-fleet.js` (Layer 2) and `delivery.js` (Layer 2) to reference them without mutual dependency.
   - **Phoenix Protocol Hook**: `phoenix-protocol.js` (Layer 3) registers its failover callback with `channel-helpers.js` (Layer 2) via `registerChannelFailoverHandler(activatePhoenixProtocol)`. This eliminates the need for `channel-helpers.js` to statically or dynamically import `phoenix-protocol.js`.
   - **Delivery & Channel Helpers**: `delivery.js` imports channel resolution from `channel-helpers.js`; `filestore.js` imports storage-copying functions from `delivery.js` and existence checks from `channel-helpers.js`.

3. **100% Static Module Imports**:
   - All runtime dynamic `await import(...)` calls have been eliminated.
   - The module graph is fully statically resolvable at compile/boot time, ensuring predictable startup performance and eliminating hidden runtime import errors.
