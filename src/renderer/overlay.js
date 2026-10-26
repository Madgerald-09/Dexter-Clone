'use strict';

document.querySelectorAll('[data-command]').forEach((button) => {
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await window.dexter.sendOverlayCommand(button.dataset.command);
      if (button.dataset.command !== 'help') await window.dexter.closeOverlay();
    } catch (error) {
      button.title = error.message || 'Could not run the quick action.';
    } finally {
      button.disabled = false;
    }
  });
});

document.querySelector('#overlay-close').addEventListener('click', () => window.dexter.closeOverlay());
document.querySelector('#overlay-main').addEventListener('click', () => window.dexter.focusMainWindow());
