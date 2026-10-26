// InfoCapture deployment settings (see README.md, "Setup"), so teammates only
// have to open the app and sign in. Anything entered on the app's Settings
// screen overrides these values on that one device. None of these are
// secrets: the publishable key is meant for browsers, and the database rules
// (supabase/setup.sql) let only signed-in team members in.
export default {
  // Supabase > Project Settings > API > Project URL
  supabaseUrl: 'https://vdcwyqththjkgbskthcb.supabase.co',

  // Supabase > Project Settings > API Keys > Publishable key
  supabaseKey: 'sb_publishable_1kx6CyINd7l1HNBrAc36hQ_AUoyBrDO',

  // "CardReaderUrl" output of the card reader stack (a Lambda function URL).
  // Leave blank to skip automatic card reading; photos are still saved.
  cardReaderUrl: 'https://slqweaor23sc2kmxtziom2cm7i0elrtz.lambda-url.us-east-2.on.aws/',
};
