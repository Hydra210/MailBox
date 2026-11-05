export default {
  async email(message, env) {
    if (message.rawSize > 25 * 1024 * 1024) {
      message.setReject("Message exceeds the supported 25 MiB limit.");
      return;
    }

    const endpoint = env.MAILBOX_INGEST_URL;
    const secret = env.MAILBOX_INBOUND_SECRET;
    if (!endpoint || !secret) {
      message.setReject("Mailbox receiver is not configured.");
      return;
    }

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + secret,
          "Content-Type": "message/rfc822",
          "X-Envelope-To": message.to,
          "X-Envelope-From": message.from
        },
        body: message.raw
      });

      if (!response.ok) {
        message.setReject("Mailbox receiver returned " + response.status + ".");
      }
    } catch (_error) {
      message.setReject("Mailbox receiver is temporarily unavailable.");
    }
  }
};
