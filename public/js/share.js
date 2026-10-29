// The screenshot page: paste, drop or pick pictures; each one is uploaded and listed with its saved name.
import { imagesIn, sendShot } from './upload.js';

const $ = (id) => document.getElementById(id);

async function send(files) {
  if (!files.length) return;
  $('err').textContent = '';
  const note = $('note').value.trim();
  $('note').value = '';
  for (const file of files) {
    const li = document.createElement('li');
    const img = document.createElement('img');
    img.src = URL.createObjectURL(file);
    img.alt = '';
    const text = document.createElement('div');
    const status = document.createElement('strong');
    status.textContent = 'Sending…';
    const detail = document.createElement('span');
    text.append(status, detail);
    li.append(img, text);
    $('list').prepend(li);
    try {
      const { name } = await sendShot(file, note);
      status.textContent = 'Saved';
      detail.textContent = `uploads/${name}${note ? ' (with your note)' : ''}`;
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.textContent = 'Copy name';
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(`uploads/${name}`); copy.textContent = 'Copied'; } catch { copy.textContent = 'Select it above'; }
      });
      text.append(copy);
    } catch (e) {
      status.textContent = 'Not sent';
      detail.textContent = e.message;
      li.classList.add('failed');
    }
  }
}

document.addEventListener('paste', (e) => {
  const files = imagesIn(e.clipboardData);
  if (!files.length) return; // plain text paste into the note works as usual
  e.preventDefault();
  send(files);
});

const drop = $('drop');
for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, () => drop.classList.remove('over'));
// drops anywhere on the page count (the box is just a target): a near miss shouldn't open the picture instead
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => { e.preventDefault(); send(imagesIn(e.dataTransfer)); });
$('pick').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', () => { send([...$('file').files]); $('file').value = ''; });
