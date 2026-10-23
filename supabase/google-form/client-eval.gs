/**
 * Apps Script for the Google Form "CLIENT'S FEEDBACK & PERFORMANCE EVALUATION FORM".
 * Sends every response (with the rater's verified email) to the GBMA HRIS, which fills in the
 * client's ratings and remarks in the employee's evaluation.
 *
 * Setup (once), in the form: Extensions > Apps Script
 *   1. Paste this whole file into Code.gs and save.
 *   2. Project Settings > Script Properties > Add: HRIS_TOKEN = the CLIENT_EVAL_TOKEN value from .env.local
 *   3. Run "setup" (allow the permissions it asks for). Responses are then sent as they come in.
 *   4. Run "sendAll" once to send the responses already in the form.
 */
const HRIS_URL = 'https://mgmbtqjgcmzeqsbdfnwp.supabase.co/functions/v1/gform-eval';

function setup() {
  const form = FormApp.getActiveForm();
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'onSubmit').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('onSubmit').forForm(form).onFormSubmit().create();
}

function onSubmit(e) {
  send_([e.response]);
}

function sendAll() {
  const all = FormApp.getActiveForm().getResponses();
  for (let i = 0; i < all.length; i += 100) send_(all.slice(i, i + 100));
}

function send_(responses) {
  const token = PropertiesService.getScriptProperties().getProperty('HRIS_TOKEN');
  if (!token) throw new Error('Add the script property HRIS_TOKEN first (Project Settings > Script Properties).');
  const rows = responses.map(r => ({
    id: r.getId(),
    at: r.getTimestamp().toISOString(),
    email: r.getRespondentEmail(),
    answers: r.getItemResponses().map(a => ({ title: a.getItem().getTitle(), value: a.getResponse() })),
  }));
  const res = UrlFetchApp.fetch(HRIS_URL, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    payload: JSON.stringify({ token: token, rows: rows }),
  });
  if (res.getResponseCode() !== 200) throw new Error('HRIS did not accept the responses: ' + res.getContentText());
  Logger.log(res.getContentText());
}
