// Shared by the login page and the hunt page, so a team sees the same thing
// whether or not they are signed in.

const pad = n => String(n).padStart(2, '0');

const WHEN = new Intl.DateTimeFormat('en-AU', {
  weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit'
});

// opensAt / serverNow are ISO strings. serverNow lets the countdown ignore a
// device clock that is wrong, which on a room full of school laptops is common.
export function startCountdown(host, opensAt, serverNow, onOpen) {
  const target = new Date(opensAt).getTime();
  const skew = serverNow ? new Date(serverNow).getTime() - Date.now() : 0;
  let timer = null;

  const unit = (n, label) =>
    `<div class="cd-unit"><span class="cd-n">${pad(n)}</span><span class="cd-l">${label}</span></div>`;

  function tick() {
    const left = target - (Date.now() + skew);
    if (left <= 0) {
      clearInterval(timer);
      host.innerHTML = `<div class="countdown"><p class="cd-lead">The hunt is open</p></div>`;
      if (onOpen) onOpen();
      return;
    }
    const s = Math.floor(left / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);

    host.innerHTML = `
      <div class="countdown">
        <p class="cd-lead">The hunt opens in</p>
        <div class="cd-units">
          ${d > 0 ? unit(d, d === 1 ? 'day' : 'days') : ''}
          ${unit(h, h === 1 ? 'hour' : 'hours')}
          ${unit(m, m === 1 ? 'minute' : 'minutes')}
          ${unit(s % 60, 'seconds')}
        </div>
        <hr class="rule">
        <p class="cd-when">${WHEN.format(new Date(target))}</p>
      </div>`;
  }

  tick();
  timer = setInterval(tick, 1000);
  return () => clearInterval(timer);
}
