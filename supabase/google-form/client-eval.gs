/**
 * Apps Script for the Google Form "CLIENT'S FEEDBACK & PERFORMANCE EVALUATION FORM".
 *  - Sends every response (with the rater's verified email) to the GBMA HRIS, which fills in the
 *    client's ratings and remarks in the employee's evaluation.
 *  - Every hour, asks the HRIS which evaluation links are due and emails them to the client supervisors
 *    from this Google account: 7 days before the evaluation is due, and one reminder 3 days later
 *    if the client has not answered. (The HRIS sends nothing before 8:00 AM Manila time.)
 *
 * Setup (once), in the form: Extensions > Apps Script
 *   1. Paste this whole file into Code.gs and save.
 *   2. Project Settings > Script Properties > Add: HRIS_TOKEN = the CLIENT_EVAL_TOKEN value from .env.local
 *   3. Run "setup" (allow the permissions it asks for).
 */
const HRIS_URL = 'https://mgmbtqjgcmzeqsbdfnwp.supabase.co/functions/v1/gform-eval';
const SENDER_NAME = 'Golden Bear Manpower Agency - HR';

function setup() {
  const form = FormApp.getActiveForm();
  ScriptApp.getProjectTriggers()
    .filter(t => ['onSubmit', 'sendEvaluationEmails'].indexOf(t.getHandlerFunction()) >= 0)
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('onSubmit').forForm(form).onFormSubmit().create();
  ScriptApp.newTrigger('sendEvaluationEmails').timeBased().everyHours(1).create();
}

function onSubmit(e) {
  send_([e.response]);
}

function sendAll() {
  const all = FormApp.getActiveForm().getResponses();
  for (let i = 0; i < all.length; i += 100) send_(all.slice(i, i + 100));
}

function sendEvaluationEmails() {
  const due = call_({ action: 'due' });
  const sent = [];
  (due.items || []).forEach(m => {
    try {
      MailApp.sendEmail({ to: m.to, subject: m.subject, body: m.body, name: SENDER_NAME });
      sent.push({ key: m.key, kind: m.kind, to: m.to, employeeId: m.employeeId, period: m.period });
    } catch (err) {
      Logger.log('Could not email ' + m.to + ': ' + err);
    }
  });
  if (sent.length) call_({ action: 'sent', items: sent });
  Logger.log('Emails sent: ' + sent.length);
}

function send_(responses) {
  const rows = responses.map(r => ({
    id: r.getId(),
    at: r.getTimestamp().toISOString(),
    email: r.getRespondentEmail(),
    answers: r.getItemResponses().map(a => ({ title: a.getItem().getTitle(), value: a.getResponse() })),
  }));
  Logger.log(JSON.stringify(call_({ rows: rows })));
}

function call_(payload) {
  const token = PropertiesService.getScriptProperties().getProperty('HRIS_TOKEN');
  if (!token) throw new Error('Add the script property HRIS_TOKEN first (Project Settings > Script Properties).');
  payload.token = token;
  const res = UrlFetchApp.fetch(HRIS_URL, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true, payload: JSON.stringify(payload),
  });
  if (res.getResponseCode() !== 200) throw new Error('HRIS did not accept the request: ' + res.getContentText());
  return JSON.parse(res.getContentText());
}
