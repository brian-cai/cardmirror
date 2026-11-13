/**
 * Harness boot: put the app's own page markup in place first (some dialog
 * modules pull in the app entry, which wires up index.html's elements on
 * import), then load the scenarios. The dialogs open over the running app,
 * as they do for a user.
 */
const html = await (await fetch('/index.html')).text();
const page = new DOMParser().parseFromString(html, 'text/html');
for (const s of page.body.querySelectorAll('script')) s.remove();
for (const a of page.documentElement.attributes) document.documentElement.setAttribute(a.name, a.value);
document.body.innerHTML = page.body.innerHTML;
for (const a of page.body.attributes) document.body.setAttribute(a.name, a.value);
await import('./harness.js');
export {};
