// InfoCapture deployment settings. Fill these in once (see README.md,
// "Set up Microsoft 365" and "Deploy the card reader") so teammates only
// have to open the app and sign in. Anything entered on the app's Settings
// screen overrides these values on that one device.
export default {
  // Entra admin center > Overview > Tenant ID
  tenantId: '',

  // Entra admin center > App registrations > InfoCapture > Application (client) ID
  clientId: '',

  // Scope the app requests for the card reader. Leave blank to use
  // api://<clientId>/access_as_user (the value the README sets up).
  apiScope: '',

  // "CardReaderUrl" output of the CloudFormation stack (a Lambda function URL).
  // Leave blank to skip automatic card reading; photos are still saved.
  cardReaderUrl: '',

  // Where contacts are written. Either a path in the signed-in person's
  // OneDrive (created on first sync), or a sharing link to a workbook in
  // SharePoint/OneDrive so a whole team writes to one file.
  workbook: '/InfoCapture/InfoCapture Leads.xlsx',
};
