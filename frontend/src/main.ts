import { mount } from 'svelte';
import { registerSW } from 'virtual:pwa-register';
import './app.css';
import App from './App.svelte';

registerSW({
  immediate: true,
  // An installed app is resumed far more often than it is reloaded, and the browser only
  // checks for a new service worker on a load. Without this, a phone can sit on an old
  // build for days, still opening apps at addresses that have since moved. With
  // autoUpdate, a new worker found here reloads the page onto the new build.
  onRegisteredSW(_url, registration) {
    if (!registration) return;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') registration.update().catch(() => {});
    });
  }
});

export default mount(App, { target: document.getElementById('app')! });
