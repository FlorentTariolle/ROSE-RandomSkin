/**
 * LU-RandomSkin Plugin
 * Shows dice button and random flag at rewards location based on Python state
 */
(function initRandomSkin() {
  const LOG_PREFIX = "[LU-RandomSkin]";
  const REWARDS_SELECTOR = ".skin-selection-item-information.loyalty-reward-icon--rewards";
  const RGM_FLAG_IMAGE_PATH = "rcp-fe-lol-champ-select/global/default/images/config/champ-free-to-play-rgm-flag.png";
  
  // WebSocket bridge for receiving random mode state from Python
  const BRIDGE_URL = "ws://localhost:3000";
  let bridgeSocket = null;
  let bridgeReady = false;
  let bridgeQueue = [];
  
  let randomModeActive = false;
  let currentRewardsElement = null;
  let rgmFlagImageUrl = null; // HTTP URL from Python or LCU path
  const pendingRgmFlagRequest = new Map(); // Track pending requests
  
  // Dice button state
  let diceButtonElement = null;
  let diceButtonState = 'disabled'; // 'disabled' or 'enabled'
  
  const CSS_RULES = `
    .skin-selection-item-information.loyalty-reward-icon--rewards.lu-random-flag-active {
      background-repeat: no-repeat !important;
      background-size: contain !important;
      height: 32px !important;
      width: 32px !important;
      position: absolute !important;
      right: -14px !important;
      top: -14px !important;
      pointer-events: none !important;
      cursor: default !important;
      -webkit-user-select: none !important;
      list-style-type: none !important;
      content: " " !important;
    }
    
    .lu-random-dice-button {
      position: absolute !important;
      width: 46px !important;
      height: 27px !important;
      cursor: pointer !important;
      z-index: 10000 !important;
      pointer-events: auto !important;
      background-size: contain !important;
      background-repeat: no-repeat !important;
      background-position: center !important;
    }
    
    .lu-random-dice-button:hover {
      opacity: 0.8 !important;
    }
    
    .lu-random-dice-button.disabled {
      background-image: url('rcp-fe-lol-champ-select/global/default/images/config/champ-free-to-play-rgm-dice-disabled.png') !important;
    }
    
    .lu-random-dice-button.enabled {
      background-image: url('rcp-fe-lol-champ-select/global/default/images/config/champ-free-to-play-rgm-dice-enabled.png') !important;
    }
  `;
  
  function log(level, message, data = null) {
    const payload = {
      type: "chroma-log",
      source: "LU-RandomSkin",
      level: level,
      message: message,
      timestamp: Date.now(),
    };
    if (data) payload.data = data;
    
    if (bridgeReady && bridgeSocket && bridgeSocket.readyState === WebSocket.OPEN) {
      bridgeSocket.send(JSON.stringify(payload));
    } else {
      bridgeQueue.push(JSON.stringify(payload));
    }
    
    // Also log to console for debugging
    const consoleMethod = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    consoleMethod(`${LOG_PREFIX} ${message}`, data || "");
  }
  
  function setupBridgeSocket() {
    if (bridgeSocket && bridgeSocket.readyState === WebSocket.OPEN) {
      return;
    }
    
    try {
      bridgeSocket = new WebSocket(BRIDGE_URL);
      
      bridgeSocket.onopen = () => {
        log("info", "WebSocket bridge connected");
        bridgeReady = true;
        flushBridgeQueue();
      };
      
      bridgeSocket.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          handleBridgeMessage(payload);
        } catch (e) {
          log("error", "Failed to parse bridge message", { error: e.message });
        }
      };
      
      bridgeSocket.onerror = (error) => {
        log("warn", "WebSocket bridge error", { error: error.message || "Unknown error" });
      };
      
      bridgeSocket.onclose = () => {
        log("info", "WebSocket bridge closed, reconnecting...");
        bridgeReady = false;
        bridgeSocket = null;
        scheduleBridgeRetry();
      };
    } catch (e) {
      log("error", "Failed to setup WebSocket bridge", { error: e.message });
      scheduleBridgeRetry();
    }
  }
  
  function scheduleBridgeRetry() {
    setTimeout(() => {
      if (!bridgeReady) {
        setupBridgeSocket();
      }
    }, 3000);
  }
  
  function flushBridgeQueue() {
    if (bridgeQueue.length > 0 && bridgeReady && bridgeSocket && bridgeSocket.readyState === WebSocket.OPEN) {
      bridgeQueue.forEach((message) => {
        bridgeSocket.send(message);
      });
      bridgeQueue = [];
    }
  }
  
  function handleBridgeMessage(payload) {
    if (payload.type === "random-mode-state") {
      handleRandomModeStateUpdate(payload);
    } else if (payload.type === "local-asset-url") {
      handleLocalAssetUrl(payload);
    }
  }
  
  function handleLocalAssetUrl(data) {
    const assetPath = data.assetPath;
    const url = data.url;
    
    if (assetPath === RGM_FLAG_IMAGE_PATH && url) {
      rgmFlagImageUrl = url;
      pendingRgmFlagRequest.delete(RGM_FLAG_IMAGE_PATH);
      log("info", "Received RGM flag image URL from Python", { url: url });
      
      // Update the flag if it's currently active
      if (randomModeActive) {
        updateRandomFlag();
      }
    }
  }
  
  function handleRandomModeStateUpdate(data) {
    const wasActive = randomModeActive;
    randomModeActive = data.active === true;
    diceButtonState = data.diceState || 'disabled';
    
    log("info", "Received random mode state update", { 
      active: randomModeActive, 
      wasActive: wasActive,
      diceState: diceButtonState,
      randomSkinId: data.randomSkinId
    });
    
    // Update dice button state
    updateDiceButton();
    
    // Always update the flag when we receive a state update (even if state didn't change)
    // This ensures the flag is shown even if the element wasn't found initially
    updateRandomFlag();
  }
  
  function findRewardsElement() {
    // Try to find the rewards element in the selected skin item first
    const selectedItem = document.querySelector(".skin-selection-item.skin-selection-item-selected");
    if (selectedItem) {
      const info = selectedItem.querySelector(".skin-selection-item-information.loyalty-reward-icon--rewards");
      if (info) {
        log("debug", "Found rewards element in selected skin item");
        return info;
      }
    }
    
    // Try direct selector
    const element = document.querySelector(REWARDS_SELECTOR);
    if (element) {
      log("debug", "Found rewards element via direct selector");
      return element;
    }
    
    // If not found, try to find it in the skin selection carousel
    const carousel = document.querySelector(".skin-selection-carousel");
    if (carousel) {
      const items = carousel.querySelectorAll(".skin-selection-item");
      for (const item of items) {
        const info = item.querySelector(".skin-selection-item-information");
        if (info && info.classList.contains("loyalty-reward-icon--rewards")) {
          log("debug", "Found rewards element in carousel item");
          return info;
        }
      }
    }
    
    log("debug", "Rewards element not found anywhere");
    return null;
  }
  
  function findDiceButtonLocation() {
    // Find the dice button location - it should be near the center bottom of the skin selection area
    // Similar to Python's positioning: center_x = 800, center_y = 754 for 1600x900
    const skinCarousel = document.querySelector(".skin-selection-carousel");
    if (!skinCarousel) {
      return null;
    }
    
    const rect = skinCarousel.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.bottom - 50; // Position near bottom center
    
    return {
      x: centerX - 23, // Half of button width (46px)
      y: centerY - 13.5, // Half of button height (27px)
      width: 46,
      height: 27
    };
  }
  
  function createDiceButton() {
    // Remove existing button if it exists
    if (diceButtonElement) {
      diceButtonElement.remove();
      diceButtonElement = null;
    }
    
    const location = findDiceButtonLocation();
    if (!location) {
      log("debug", "Could not find dice button location");
      return;
    }
    
    const button = document.createElement("div");
    button.className = `lu-random-dice-button ${diceButtonState}`;
    button.style.left = `${location.x}px`;
    button.style.top = `${location.y}px`;
    button.style.width = `${location.width}px`;
    button.style.height = `${location.height}px`;
    
    // Add click handler
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      handleDiceButtonClick();
    });
    
    document.body.appendChild(button);
    diceButtonElement = button;
    
    log("info", "Created dice button", { x: location.x, y: location.y, state: diceButtonState });
  }
  
  function updateDiceButton() {
    if (!diceButtonElement) {
      createDiceButton();
      return;
    }
    
    // Update button state
    diceButtonElement.className = `lu-random-dice-button ${diceButtonState}`;
    log("debug", "Updated dice button state", { state: diceButtonState });
  }
  
  function handleDiceButtonClick() {
    log("info", "Dice button clicked", { currentState: diceButtonState });
    
    // Send click event to Python
    const payload = {
      type: "dice-button-click",
      state: diceButtonState,
      timestamp: Date.now(),
    };
    
    if (bridgeReady && bridgeSocket && bridgeSocket.readyState === WebSocket.OPEN) {
      bridgeSocket.send(JSON.stringify(payload));
    } else {
      bridgeQueue.push(JSON.stringify(payload));
      log("warn", "Bridge not ready, queued dice button click");
    }
  }
  
  function requestRgmFlagImage() {
    // Request RGM flag image from Python (same way as Elementalist Lux icons)
    // First try to use LCU path directly, if that doesn't work, request from Python
    if (!rgmFlagImageUrl && !pendingRgmFlagRequest.has(RGM_FLAG_IMAGE_PATH)) {
      pendingRgmFlagRequest.set(RGM_FLAG_IMAGE_PATH, true);
      
      // Try LCU path first (relative to client)
      const lcuPath = RGM_FLAG_IMAGE_PATH;
      rgmFlagImageUrl = lcuPath; // Use LCU path directly
      log("info", "Using LCU path for RGM flag", { path: lcuPath });
      
      // Also request from Python as fallback
      const payload = {
        type: "request-local-asset",
        assetPath: RGM_FLAG_IMAGE_PATH,
        timestamp: Date.now(),
      };
      
      log("debug", "Requesting RGM flag image from Python (fallback)", { assetPath: RGM_FLAG_IMAGE_PATH });
      
      if (bridgeReady && bridgeSocket && bridgeSocket.readyState === WebSocket.OPEN) {
        bridgeSocket.send(JSON.stringify(payload));
      } else {
        bridgeQueue.push(JSON.stringify(payload));
      }
    }
  }
  
  function updateRandomFlag() {
    // Always find the element in the currently selected skin (don't use cached element)
    const element = findRewardsElement();
    
    if (!element) {
      log("debug", "Rewards element not found, will retry");
      // Retry after a short delay (max 5 retries to avoid infinite loop)
      if (!updateRandomFlag._retryCount) {
        updateRandomFlag._retryCount = 0;
      }
      if (updateRandomFlag._retryCount < 5) {
        updateRandomFlag._retryCount++;
        setTimeout(updateRandomFlag, 500);
      } else {
        log("warn", "Rewards element not found after 5 retries, giving up");
        updateRandomFlag._retryCount = 0; // Reset for next attempt
      }
      return;
    }
    
    // Reset retry count on success
    updateRandomFlag._retryCount = 0;
    
    // If we have a previously cached element that's different from the current one, hide it first
    if (currentRewardsElement && currentRewardsElement !== element) {
      log("debug", "Selected skin changed - hiding flag on previous element");
      hideFlagOnElement(currentRewardsElement);
    }
    
    currentRewardsElement = element;
    
    // Log element state for debugging
    const computedStyle = window.getComputedStyle(element);
    const isVisible = computedStyle.display !== "none" && computedStyle.visibility !== "hidden" && computedStyle.opacity !== "0";
    log("debug", "Found rewards element", {
      display: computedStyle.display,
      visibility: computedStyle.visibility,
      opacity: computedStyle.opacity,
      isVisible: isVisible,
      classes: Array.from(element.classList)
    });
    
    if (randomModeActive) {
      // Request image if we don't have it yet
      if (!rgmFlagImageUrl) {
        requestRgmFlagImage();
        // Wait for image URL before applying
        return;
      }
      
      // Force element to be visible (rewards icon is usually hidden)
      element.style.setProperty("display", "block", "important");
      element.style.setProperty("visibility", "visible", "important");
      element.style.setProperty("opacity", "1", "important");
      
      // Apply the image URL (LCU path or Python-served HTTP URL)
      element.classList.add("lu-random-flag-active");
      element.style.setProperty("background-image", `url("${rgmFlagImageUrl}")`, "important");
      element.style.setProperty("background-repeat", "no-repeat", "important");
      element.style.setProperty("background-size", "contain", "important");
      element.style.setProperty("height", "32px", "important");
      element.style.setProperty("width", "32px", "important");
      element.style.setProperty("position", "absolute", "important");
      element.style.setProperty("right", "-14px", "important");
      element.style.setProperty("top", "-14px", "important");
      element.style.setProperty("pointer-events", "none", "important");
      element.style.setProperty("cursor", "default", "important");
      element.style.setProperty("-webkit-user-select", "none", "important");
      element.style.setProperty("list-style-type", "none", "important");
      element.style.setProperty("content", " ", "important");
      
      log("info", "Random flag shown on rewards element", { 
        url: rgmFlagImageUrl,
        display: element.style.display,
        visibility: element.style.visibility
      });
    } else {
      // Random mode is inactive - hide the flag
      hideFlagOnElement(element);
      log("info", "Random flag hidden on rewards element");
    }
  }
  
  function hideFlagOnElement(element) {
    if (!element) return;
    
    element.classList.remove("lu-random-flag-active");
    element.style.removeProperty("background-image");
    element.style.removeProperty("background-repeat");
    element.style.removeProperty("background-size");
    element.style.removeProperty("height");
    element.style.removeProperty("width");
    element.style.removeProperty("position");
    element.style.removeProperty("right");
    element.style.removeProperty("top");
    element.style.removeProperty("pointer-events");
    element.style.removeProperty("cursor");
    element.style.removeProperty("-webkit-user-select");
    element.style.removeProperty("list-style-type");
    element.style.removeProperty("content");
    // Explicitly hide the element (rewards icon is usually hidden by default)
    element.style.setProperty("display", "none", "important");
    element.style.setProperty("visibility", "hidden", "important");
    element.style.setProperty("opacity", "0", "important");
  }
  
  function init() {
    log("info", "Initializing LU-RandomSkin plugin");
    
    // Ensure random mode starts as inactive
    randomModeActive = false;
    diceButtonState = 'disabled';
    
    // Inject CSS
    const style = document.createElement("style");
    style.textContent = CSS_RULES;
    document.head.appendChild(style);
    
    // Setup WebSocket bridge
    setupBridgeSocket();
    
    // Watch for DOM changes to find rewards element and dice button location
    const observer = new MutationObserver(() => {
      if (randomModeActive && !currentRewardsElement) {
        updateRandomFlag();
      }
      // Update dice button if location changes
      if (!diceButtonElement) {
        createDiceButton();
      }
    });
    
    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
    
    // Request RGM flag image on init (for when it's needed)
    requestRgmFlagImage();
    
    // Initial check - ensure flag is hidden on startup (random mode starts inactive)
    setTimeout(() => {
      // Force update to ensure flag is hidden if element exists
      updateRandomFlag();
      // Create dice button
      createDiceButton();
    }, 1000);
    
    log("info", "LU-RandomSkin plugin initialized");
  }
  
  // Start when DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

