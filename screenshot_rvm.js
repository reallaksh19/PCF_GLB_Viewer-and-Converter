const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Reroute console to node console
  page.on('console', msg => console.log('BROWSER CONSOLE:', msg.text()));

  await page.goto('http://localhost:3000/viewer/index.html');
  await page.waitForTimeout(2000); // Wait for initial render

  // Switch to the 3D RVM VIEWER tab
  const tabs = await page.$$('nav#tab-bar button');
  for (const tab of tabs) {
    const name = await tab.innerText();
    if (name.includes('RVM VIEWER') || name.includes('3D RVM')) {
      await tab.click();
      break;
    }
  }

  await page.waitForTimeout(2000);

  await page.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.id = 'test-raw-input';
    input.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (file) {
            console.log("Got file:", file.name, "size:", file.size);
            try {
                const pipeline = await import('./rvm/RvmLoadPipeline.js');
                console.log("Starting loadRvmSource...");

                // Construct the correct input for loadRvmSource
                const inputObj = {
                    kind: 'raw-rvm',
                    file: file
                };

                // Construct a mock context just to satisfy it if possible,
                // Wait, AssistedBridge needs to convert the raw rvm which requires a backend...
                // Our test_server.js *might* mock it or proxy it.
                // Let's see if test_server.js has the assisted bridge endpoint mock.
                // It does! test_server.js handles NATIVE_RVM_API_PATH

                // The actual app logic imports staticBundleLoader and assistedBridge
                const staticLoader = await import('./rvm/RvmStaticBundleLoader.js');
                // The assisted bridge is not directly imported in pipeline, but passed in via ctx.
                // It seems `viewer3d-rvm-tab.js` handles loading or someone else does.

                // Actually we just need to emit FILE_LOADED correctly so app.js does it
                const eventBusModule = await import('./core/event-bus.js');
                const contractsModule = await import('./contracts/runtime-events.js');

                eventBusModule.emit(contractsModule.RuntimeEvents.FILE_LOADED, {
                    name: file.name,
                    source: 'test-script',
                    payload: file // app.js or whoever listens expects `payload` to be the file?
                });
                console.log("Emitted FILE_LOADED");

            } catch (err) {
                console.error("Pipeline failed:", err.message);
            }
        }
    });
    document.body.appendChild(input);
  });

  const fileInput = await page.$('#test-raw-input');
  if (fileInput) {
    const filePath = path.resolve(__dirname, 'BM1/Sample 4_ RVM TO REV TO XML TO CII/RMSS.rvm');
    await fileInput.setInputFiles(filePath);
    console.log(`Uploaded ${filePath}`);

    // Wait for the model to parse and render.
    await page.waitForTimeout(20000);
  } else {
    console.error("Could not find test raw file input.");
  }

  // Take the screenshot
  await page.screenshot({ path: 'rmss_rvm_viewer.png', fullPage: true });
  console.log("RVM Viewer screenshot saved to rmss_rvm_viewer.png");

  await browser.close();
})();
