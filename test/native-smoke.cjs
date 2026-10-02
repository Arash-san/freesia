const { app, BrowserWindow, globalShortcut, session } = require('electron');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const artifacts = path.resolve(__dirname, '../.tmp');
fs.mkdirSync(artifacts, {recursive:true});
const profile = fs.mkdtempSync(path.join(artifacts, 'native-profile-'));
app.setPath('userData',profile);
app.setPath('appData',profile);
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
globalShortcut.register = () => true;
globalShortcut.unregisterAll = () => {};
globalShortcut.unregister = () => {};
require('../src/main/main.js');
const sleep = ms => new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
  session.defaultSession.webRequest.onBeforeRequest({urls:['https://*/*','http://*/*']},(_,cb)=>cb({cancel:true}));
  try {
    let main, overlay;
    for (let attempt=0; attempt<80; attempt++) {
      const windows=BrowserWindow.getAllWindows();
      main=windows.find(w=>w.webContents.getURL().endsWith('index.html'));
      overlay=windows.find(w=>w.webContents.getURL().endsWith('overlay.html'));
      if (main && overlay && !main.webContents.isLoading() && !overlay.webContents.isLoading()) {
        const ready=await main.webContents.executeJavaScript('typeof startRecording === "function" && typeof freesia === "object"');
        if (ready) break;
      }
      await sleep(100);
    }
    assert(main && overlay);
    assert.equal(await main.webContents.executeJavaScript('freesia.getSetting("errorReporting")'),true,'new install defaults reporting on');
    await main.webContents.executeJavaScript('freesia.setSetting("errorReporting",false)');
    main.show();
    await main.webContents.executeJavaScript('showScreen("screenOnboarding");obGo(1);');
    await sleep(500);
    fs.writeFileSync(path.join(artifacts,'onboarding.png'),(await main.webContents.capturePage()).toPNG());
    await main.webContents.executeJavaScript('showScreen("screenMain");renderUpdateStatus({status:"downloaded",message:"Version 2.5.0 is ready. Restart to install.",updateInfo:{version:"2.5.0"}});');
    await sleep(500);
    fs.writeFileSync(path.join(artifacts,'home.png'),(await main.webContents.capturePage()).toPNG());
    const devices=await main.webContents.executeJavaScript('navigator.mediaDevices.enumerateDevices().then(ds=>ds.filter(d=>d.kind==="audioinput").length)');
    assert(devices>0);
    await overlay.webContents.executeJavaScript('window.levels=[];window.freesia.onOverlayAudioLevel(v=>window.levels.push(v));true;');
    await main.webContents.executeJavaScript(`
      showScreen('screenMain');
      window.fetch=async()=>({ok:true,status:200,json:async()=>({candidates:[{content:{parts:[{text:'Synthetic speech test'}]}}]})});
      window.signalContext = new AudioContext();
      window.tone = signalContext.createOscillator();
      window.gainNode=signalContext.createGain();gainNode.gain.value=0.005;
      window.destination=signalContext.createMediaStreamDestination();
      tone.connect(gainNode);gainNode.connect(destination);tone.start();
      navigator.mediaDevices.getUserMedia=async()=>destination.stream;
      settings.keepMicReady=false; // this test checks that cancel releases the microphone
      startRecording();
    `);
    await sleep(700);
    main.hide();
    const before=await overlay.webContents.executeJavaScript('levels.length');
    await sleep(1400);
    const quiet=await overlay.webContents.executeJavaScript('({count:levels.length,peak:Math.max(...levels.slice(-10))})');
    assert(quiet.count>before+15,'hidden renderer keeps sending levels');
    assert(quiet.peak>0.65,'quiet input normalized');
    await main.webContents.executeJavaScript('gainNode.gain.value=0.8');
    await sleep(700);
    const loud=await overlay.webContents.executeJavaScript('Math.max(...levels.slice(-10))');
    assert(Math.abs(loud-quiet.peak)<0.1);
    await main.webContents.executeJavaScript('gainNode.gain.value=0');
    await sleep(700);
    assert.equal(await overlay.webContents.executeJavaScript('levels.at(-1)'),0);
    main.webContents.send('dictation-cancel');
    await sleep(500);
    const ended=await main.webContents.executeJavaScript('destination.stream.getTracks().every(t=>t.readyState==="ended")');
    assert(ended);
    // Esc (cancel) keeps the audio by default, and never transcribes or types it
    const recDir=path.join(profile,'failed-recordings');
    const audioFiles=()=>fs.existsSync(recDir)?fs.readdirSync(recDir).filter(f=>!f.endsWith('.json')):[];
    await sleep(500);
    assert.equal(audioFiles().length,1,'a cancelled take is kept');
    const meta=fs.readdirSync(recDir).filter(f=>f.endsWith('.json')).map(f=>JSON.parse(fs.readFileSync(path.join(recDir,f),'utf8')));
    assert(meta.some(m=>/Cancelled with Esc/.test(m.error||'')),'kept take is labelled as cancelled');
    assert.notEqual(await main.webContents.executeJavaScript('document.getElementById("output")?.textContent||""'),'Synthetic speech test','a cancelled take is never transcribed');
    // With the setting off, Esc discards as before
    await main.webContents.executeJavaScript(`settings.keepCancelledRecordings=false; gainNode.gain.value=0.3; startRecording();`);
    await sleep(2200);
    main.webContents.send('dictation-cancel');
    await sleep(900);
    assert.equal(audioFiles().length,1,'with keeping off, Esc discards the take');
    const result={passed:true,devices,hiddenSamples:quiet.count-before,quietPeak:quiet.peak,loudPeak:loud,tracksReleased:ended,cancelledKept:true};
    fs.writeFileSync(path.join(artifacts,'native-smoke-result.json'),JSON.stringify(result,null,2));
    console.log(JSON.stringify(result));
  } catch(error) {fs.writeFileSync(path.join(artifacts,'native-smoke-result.json'),JSON.stringify({passed:false,error:error.stack})); process.exitCode=1;}
  app.isQuitting=true; app.quit();
});
