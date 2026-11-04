export interface SmsProvider {
  sendOtp(phone: string, code: string): Promise<void>;
}

/** Dev provider. Prints the code on the server. The HTTP response also includes it outside production. */
export class ConsoleSmsProvider implements SmsProvider {
  async sendOtp(phone: string, code: string): Promise<void> {
    const tail = phone.slice(-4);
    console.info(`[sms:console] OTP for ***${tail}: ${code}`);
  }
}

/** MSG91 OTP API. Selected with SMS_PROVIDER=msg91. No vendor id is hard-coded in routes. */
export class Msg91SmsProvider implements SmsProvider {
  constructor(
    private readonly authKey: string,
    private readonly templateId: string,
  ) {}

  async sendOtp(phone: string, code: string): Promise<void> {
    if (!this.authKey || !this.templateId) {
      throw new Error('MSG91_AUTH_KEY and MSG91_TEMPLATE_ID are required');
    }
    const mobile = phone.replace(/\D/g, '');
    const response = await fetch('https://control.msg91.com/api/v5/otp', {
      method: 'POST',
      headers: {
        authkey: this.authKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        template_id: this.templateId,
        mobile,
        otp: code,
      }),
    });
    if (!response.ok) {
      throw new Error(`MSG91 request failed with status ${response.status}`);
    }
  }
}

export function createSmsProvider(kind: string, authKey: string, templateId: string): SmsProvider {
  if (kind === 'msg91') return new Msg91SmsProvider(authKey, templateId);
  return new ConsoleSmsProvider();
}
