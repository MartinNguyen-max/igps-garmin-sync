// ==========================================
// Auto-open tabs function
// ==========================================
async function getOrCreateTab(matchUrl, createUrl) {
  let tabs = await chrome.tabs.query({ url: matchUrl });
  if (tabs.length > 0) return tabs[0]; // Tab already exists

  // Open the tab in the background (active: false) so the popup doesn't close!
  let newTab = await chrome.tabs.create({ url: createUrl, active: false });

  // Wait until the tab has finished loading
  return new Promise((resolve) => {
    chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
      if (tabId === newTab.id && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        // Give the page an extra half-second to run its own security scripts
        setTimeout(() => resolve(newTab), 500);
      }
    });
  });
}

// ==========================================
// Helper functions for UI formatting
// ==========================================
function formatDate(dateStr) {
  const parts = dateStr.split(".");
  if (parts.length === 3) {
    const months = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    const day = parseInt(parts[2], 10);
    const month = months[parseInt(parts[1], 10) - 1];
    return `${day}. ${month}`;
  }
  return dateStr;
}

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// ==========================================
// 1. Fetch login token from the iGPSPORT tab
// ==========================================
async function getIGPSToken() {
  const targetTab = await getOrCreateTab(
    "https://*.igpsport.com/*",
    "https://app.igpsport.com/",
  );

  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: targetTab.id },
      func: () => {
        const findTokenInText = (str) => {
          if (!str) return null;
          const match = str.match(
            /eyJ[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+/,
          );
          return match ? match[0] : null;
        };
        for (let i = 0; i < localStorage.length; i++) {
          const val = localStorage.getItem(localStorage.key(i));
          const found = findTokenInText(val);
          if (found) return found;
        }
        return null;
      },
    });
    return result && result.result
      ? { status: "success", token: result.result }
      : { status: "missing_token" };
  } catch (err) {
    return { status: "script_error", error: err.message };
  }
}

// ==========================================
// 2. Download .fit file from iGPSPORT
// ==========================================
async function downloadRideAsBase64(rideId, token) {
  const apiUrl = `https://prod.en.igpsport.com/service/web-gateway/web-analyze/activity/getDownloadUrl/${rideId}`;

  const response = await fetch(apiUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json, text/plain, */*",
    },
  });

  if (!response.ok) {
    throw new Error(
      `iGPSPORT server responded with error status: ${response.status}`,
    );
  }

  const contentType = response.headers.get("content-type");
  if (!contentType || !contentType.includes("application/json")) {
    throw new Error(
      "Received an invalid response from iGPSPORT (likely a temporary error page).",
    );
  }

  const result = await response.json();

  if (result.code !== 0 || !result.data) {
    throw new Error(
      `iGPSPORT rejected the download: ${result.message || "Unknown error"}`,
    );
  }

  const fileResponse = await fetch(result.data);
  if (!fileResponse.ok) {
    throw new Error(
      `Could not fetch the .fit file from the storage server (Status: ${fileResponse.status})`,
    );
  }

  const fileBlob = await fileResponse.blob();

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(fileBlob);
  });
}

// ==========================================
// 3. Initiate upload inside the Garmin Connect tab
// ==========================================
async function uploadToGarminTab(base64Data, filename) {
  const garminTab = await getOrCreateTab(
    "https://connect.garmin.com/*",
    "https://connect.garmin.com/modern/",
  );

  const [scriptResult] = await chrome.scripting.executeScript({
    target: { tabId: garminTab.id },
    args: [base64Data, filename],
    func: async (b64, fname) => {
      const metaTag =
        document.querySelector('meta[name="csrf-token"]') ||
        document.querySelector('meta[name="connect-csrf-token"]');
      const csrfToken = metaTag ? metaTag.content : null;

      if (!csrfToken) {
        throw new Error("NOT_LOGGED_IN");
      }

      const binaryStr = atob(b64);
      const len = binaryStr.length;

      console.log(`[Garmin Tab] Received Base64 string of length: ${len}`);

      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      const fitBlob = new Blob([bytes], { type: "application/octet-stream" });

      console.log(`[Garmin Tab] Generated Blob size: ${fitBlob.size} bytes`);

      const formData = new FormData();
      formData.append("userfile", fitBlob, fname);
      const uploadUrl =
        "https://connect.garmin.com/gc-api/upload-service/upload/.fit";

      const response = await fetch(uploadUrl, {
        method: "POST",
        headers: {
          "connect-csrf-token": csrfToken,
          "X-Requested-With": "XMLHttpRequest",
        },
        body: formData,
      });

      const resText = await response.text();
      if (!response.ok) {
        throw new Error(
          `Garmin rejected upload: ${response.status} - ${resText}`,
        );
      }

      if (!resText || resText.trim() === "" || resText.trim() === "null") {
        return null;
      }

      return JSON.parse(resText);
    },
  });

  if (scriptResult && scriptResult.result === null && scriptResult.error) {
    throw new Error(scriptResult.error);
  }

  return scriptResult.result;
}

// ==========================================
// 4. UI and Event Listeners
// ==========================================
document.addEventListener("DOMContentLoaded", async () => {
  const ridesContainer = document.getElementById("rides");
  const syncButton = document.getElementById("sync-btn");
  const queryUrl =
    "https://prod.en.igpsport.com/service/web-gateway/web-analyze/activity/queryMyActivity?pageNo=1&pageSize=20&reqType=0&sort=1";

  ridesContainer.innerHTML =
    '<p style="color: #666; font-size: 12px; text-align: center;">Checking connection to iGPSPORT... ⏳</p>';

  try {
    const auth = await getIGPSToken();

    if (auth.status !== "success") {
      ridesContainer.innerHTML = `
        <p style="color: #ffcc00; font-size: 12px; text-align: center;">
          ⚠️ You need to log in to iGPSPORT.<br><br>
          I've opened the tab in the background for you. Log in there, then reopen this menu!
        </p>`;
      return;
    }

    ridesContainer.innerHTML =
      '<p style="color: #666; font-size: 12px; text-align: center;">Fetching your recent rides...</p>';

    const response = await fetch(queryUrl, {
      headers: { Authorization: `Bearer ${auth.token}` },
    });

    if (!response.ok)
      throw new Error(
        `iGPSPORT could not fetch the list (Status: ${response.status})`,
      );

    const result = await response.json();

    if (result.code === 0 && result.data && result.data.rows) {
      ridesContainer.innerHTML = "";

      result.data.rows.forEach((ride) => {
        const niceDate = formatDate(ride.startTime);
        const distanceKm = (ride.rideDistance / 1000).toFixed(1);
        const duration = formatTime(ride.totalMovingTime);
        const speedKmh = (ride.avgSpeed * 3.6).toFixed(1);

        const card = document.createElement("div");
        card.className = "ride-card";

        card.innerHTML = `
          <div class="checkbox-container">
            <input type="checkbox" class="ride-checkbox" value="${ride.rideId}" data-date="${ride.startTime}">
          </div>
          <div class="ride-info">
            <div class="ride-top">
              <span class="ride-date">${niceDate}</span>
            </div>
            <div class="ride-stats">
              <span>Dist: <span class="stat-val">${distanceKm} km</span></span>
              <span>Time: <span class="stat-val">${duration}</span></span>
              <span>Avg: <span class="stat-val">${speedKmh} km/h</span></span>
            </div>
          </div>
        `;

        ridesContainer.appendChild(card);
      });
    } else {
      ridesContainer.innerHTML =
        '<p style="color: red; text-align: center;">Could not parse data from iGPSPORT.</p>';
    }
  } catch (error) {
    console.error("Error loading:", error);
    ridesContainer.innerHTML = `<p style="color: #ff6b6b; font-size: 12px; text-align: center;">❌ Error fetching data:<br><span style="color:#aaa">${error.message}</span></p>`;
  }

  // Click on the "Sync" button
  syncButton.addEventListener("click", async () => {
    const checkedBoxes = document.querySelectorAll(".ride-checkbox:checked");
    if (checkedBoxes.length === 0) {
      alert("Please select at least one ride!");
      return;
    }

    syncButton.disabled = true;
    let successCount = 0;
    let ignoredCount = 0;

    try {
      const auth = await getIGPSToken();
      if (auth.status !== "success")
        throw new Error("Could not verify your iGPSPORT token.");

      syncButton.innerText = "Securing Garmin connection... ⏳";
      await getOrCreateTab(
        "https://connect.garmin.com/*",
        "https://connect.garmin.com/modern/",
      );

      for (const box of checkedBoxes) {
        const rideId = box.value;
        const rideDate = box.getAttribute("data-date").replace(/\./g, "-");
        const filename = `igpsport_${rideId}_${rideDate}.fit`;

        syncButton.innerText = `Syncing ${successCount + ignoredCount + 1}/${checkedBoxes.length}...`;

        const base64Data = await downloadRideAsBase64(rideId, auth.token);
        console.log(
          `[Popup] Fetched base64 for ${filename}. Character length: ${base64Data.length}`,
        );

        const garminResponse = await uploadToGarminTab(base64Data, filename);

        if (garminResponse && garminResponse.detailedImportResult) {
          console.log(`[Popup] Successfully transferred: ${filename}`);
          successCount++;
        } else if (garminResponse === null) {
          console.warn(
            `[Popup] Garmin returned 'null' for ${filename}. Likely a duplicate or empty file.`,
          );
          ignoredCount++;
        } else {
          console.warn(
            `[Popup] Unexpected response format from Garmin for ${filename}:`,
            garminResponse,
          );
        }
      }

      if (successCount === checkedBoxes.length) {
        alert(
          `🚀 Success! All ${successCount} selected rides were transferred directly to Garmin Connect!`,
        );
      } else if (ignoredCount > 0 && successCount === 0) {
        alert(
          `⚠️ Garmin didn't catch any new rides.\n\nThe files likely already exist on your Garmin account.`,
        );
      } else {
        alert(
          `🏁 Sync complete!\n\nTransferred: ${successCount} ride(s)\nIgnored (Duplicate/error): ${ignoredCount} ride(s)`,
        );
      }
    } catch (err) {
      console.error(err);
      if (err.message.includes("NOT_LOGGED_IN")) {
        alert(
          "⚠️ You are not logged in to Garmin Connect!\n\nI've opened the tab for you. Log in there, and try syncing again.",
        );
      } else {
        alert("An error occurred during synchronization:\n" + err.message);
      }
    } finally {
      syncButton.disabled = false;
      syncButton.innerText = "Sync selected to Garmin";
    }
  });
});
