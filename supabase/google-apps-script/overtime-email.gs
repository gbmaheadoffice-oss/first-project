/**
 * GBMA Overtime Emails (Google Apps Script)
 * Every 5 minutes, asks the HRIS which overtime requests were just APPROVED or DECLINED (final decision)
 * and emails each employee from this Google account. Each request is emailed once.
 *
 * Setup (once), signed in to the Gmail account that should send the emails:
 *   1. Go to https://script.google.com > New project. Name it "GBMA Overtime Emails".
 *   2. Paste this whole file into Code.gs and save.
 *   3. Project Settings (gear icon) > Script Properties > Add: HRIS_TOKEN = the OT_EMAIL_TOKEN value from .env.local
 *   4. Back in the editor, choose "setup" and click Run (allow the permissions it asks for).
 */
const HRIS_URL = 'https://mgmbtqjgcmzeqsbdfnwp.supabase.co/functions/v1/ot-email';
const SENDER_NAME = 'Golden Bear Manpower Agency - HR';

function setup() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'sendOvertimeEmails')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('sendOvertimeEmails').timeBased().everyMinutes(5).create();
  sendOvertimeEmails();
}

function sendOvertimeEmails() {
  const due = call_({ action: 'due' });
  const sent = [];
  (due.items || []).forEach(m => {
    try {
      MailApp.sendEmail({ to: m.to, subject: m.subject, body: m.body, name: SENDER_NAME });
      sent.push({ id: m.id, to: m.to, status: m.status });
    } catch (err) {
      Logger.log('Could not email ' + m.to + ': ' + err);
    }
  });
  if (sent.length) call_({ action: 'sent', items: sent });
  Logger.log('Overtime emails sent: ' + sent.length);
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
