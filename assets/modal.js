// Themed replacements for window.confirm()/prompt() so a hint-cost check or
// a penalty entry doesn't drop into stock browser chrome mid-hunt.

function overlay(innerHtml) {
  const back = document.createElement('div');
  back.className = 'modal-backdrop';
  back.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${innerHtml}</div>`;
  document.body.appendChild(back);
  return back;
}

function close(back) { back.remove(); }

export function showConfirm({ title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel' }) {
  return new Promise(resolve => {
    const back = overlay(`
      <h2>${title}</h2>
      <p>${body}</p>
      <div class="row">
        <button id="modal-ok">${confirmLabel}</button>
        <button class="quiet" id="modal-cancel">${cancelLabel}</button>
      </div>`);
    const finish = v => { close(back); resolve(v); };
    back.querySelector('#modal-ok').addEventListener('click', () => finish(true));
    back.querySelector('#modal-cancel').addEventListener('click', () => finish(false));
    back.addEventListener('click', e => { if (e.target === back) finish(false); });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { document.removeEventListener('keydown', esc); finish(false); }
    });
    back.querySelector('#modal-ok').focus();
  });
}

export function showPrompt({ title, body = '', placeholder = '', defaultValue = '', confirmLabel = 'OK' }) {
  return new Promise(resolve => {
    const back = overlay(`
      <h2>${title}</h2>
      ${body ? `<p>${body}</p>` : ''}
      <input type="text" id="modal-input" placeholder="${placeholder}" value="${defaultValue}">
      <div class="row">
        <button id="modal-ok">${confirmLabel}</button>
        <button class="quiet" id="modal-cancel">Cancel</button>
      </div>`);
    const input = back.querySelector('#modal-input');
    const finish = v => { close(back); resolve(v); };
    back.querySelector('#modal-ok').addEventListener('click', () => finish(input.value));
    back.querySelector('#modal-cancel').addEventListener('click', () => finish(null));
    back.addEventListener('click', e => { if (e.target === back) finish(null); });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') finish(input.value);
      if (e.key === 'Escape') finish(null);
    });
    input.focus();
    input.select();
  });
}
