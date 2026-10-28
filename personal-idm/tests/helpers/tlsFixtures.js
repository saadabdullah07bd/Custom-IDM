import crypto from 'node:crypto';

function encodeLength(len) {
  if (len < 128) return Buffer.from([len]);
  const bytes = [];
  let temp = len;
  while (temp > 0) {
    bytes.unshift(temp & 0xff);
    temp >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function asn1Tag(tag, content) {
  return Buffer.concat([Buffer.from([tag]), encodeLength(content.length), content]);
}

function asn1Sequence(...items) {
  return asn1Tag(0x30, Buffer.concat(items));
}

function asn1Set(...items) {
  return asn1Tag(0x31, Buffer.concat(items));
}

function asn1Integer(buf) {
  let b = Buffer.isBuffer(buf) ? buf : Buffer.from([buf]);
  while (b.length > 1 && b[0] === 0x00) {
    b = b.subarray(1);
  }
  if (b[0] & 0x80) {
    b = Buffer.concat([Buffer.from([0x00]), b]);
  }
  return asn1Tag(0x02, b);
}

function asn1BitString(buf) {
  return asn1Tag(0x03, Buffer.concat([Buffer.from([0x00]), buf]));
}

function asn1OctetString(buf) {
  return asn1Tag(0x04, buf);
}

function asn1Oid(oidBytes) {
  return asn1Tag(0x06, Buffer.from(oidBytes));
}

function asn1Utf8String(str) {
  return asn1Tag(0x0c, Buffer.from(str, 'utf8'));
}

function asn1UtcTime(date) {
  const yy = String(date.getUTCFullYear() % 100).padStart(2, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const min = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  return asn1Tag(0x17, Buffer.from(`${yy}${mm}${dd}${hh}${min}${ss}Z`, 'ascii'));
}

function makeDistinguishedName(commonName) {
  return asn1Sequence(
    asn1Set(
      asn1Sequence(
        asn1Oid([0x55, 0x04, 0x03]),
        asn1Utf8String(commonName)
      )
    )
  );
}

function derToPem(der, label = 'CERTIFICATE') {
  const b64 = der.toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

/**
 * Generates an in-memory Root CA + signed Server Leaf Certificate for 127.0.0.1 / localhost
 */
export function generateTestCertificate({ expired = false } = {}) {
  // sha256WithRSAEncryption OID: 1.2.840.113549.1.1.11
  const sigAlg = asn1Sequence(
    asn1Oid([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]),
    Buffer.from([0x05, 0x00])
  );

  // 1. Generate Root CA
  const caKeys = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });

  const caName = makeDistinguishedName('Personal IDM Test Root CA');
  const now = Date.now();
  const caValidity = asn1Sequence(
    asn1UtcTime(new Date(now - 86400 * 1000)),
    asn1UtcTime(new Date(now + 365 * 86400 * 1000))
  );

  const caKeyId = crypto.createHash('sha1').update(caKeys.publicKey).digest();

  // BasicConstraints: CA:TRUE (critical)
  const bcCaExt = asn1Sequence(
    asn1Oid([0x55, 0x1d, 0x13]),
    Buffer.from([0x01, 0x01, 0xff]),
    asn1OctetString(asn1Sequence(Buffer.from([0x01, 0x01, 0xff])))
  );
  // KeyUsage: keyCertSign | cRLSign (0x06, unused bits 1 -> 0x03 0x02 0x01 0x06)
  const kuCaExt = asn1Sequence(
    asn1Oid([0x55, 0x1d, 0x0f]),
    Buffer.from([0x01, 0x01, 0xff]),
    asn1OctetString(Buffer.from([0x03, 0x02, 0x01, 0x06]))
  );
  // SubjectKeyIdentifier: OID 2.5.29.14
  const skiCaExt = asn1Sequence(
    asn1Oid([0x55, 0x1d, 0x0e]),
    asn1OctetString(asn1OctetString(caKeyId))
  );

  const caTbs = asn1Sequence(
    asn1Tag(0xa0, asn1Integer(2)),
    asn1Integer(crypto.randomBytes(8)),
    sigAlg,
    caName,
    caValidity,
    caName,
    caKeys.publicKey,
    asn1Tag(0xa3, asn1Sequence(bcCaExt, kuCaExt, skiCaExt))
  );
  const caSig = crypto.sign('sha256', caTbs, caKeys.privateKey);
  const caCertPem = derToPem(asn1Sequence(caTbs, sigAlg, asn1BitString(caSig)));

  // 2. Generate Server Leaf Certificate signed by Root CA
  const leafKeys = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });

  const leafName = makeDistinguishedName('localhost');
  const notBefore = expired ? new Date(now - 7200 * 1000) : new Date(now - 3600 * 1000);
  const notAfter = expired ? new Date(now - 3600 * 1000) : new Date(now + 86400 * 1000);
  const leafValidity = asn1Sequence(asn1UtcTime(notBefore), asn1UtcTime(notAfter));

  // BasicConstraints: CA:FALSE
  const bcLeafExt = asn1Sequence(
    asn1Oid([0x55, 0x1d, 0x13]),
    asn1OctetString(asn1Sequence())
  );

  // SubjectAltName: DNS:localhost, IP:127.0.0.1
  const dnsName = asn1Tag(0x82, Buffer.from('localhost', 'ascii'));
  const ipAddr = asn1Tag(0x87, Buffer.from([127, 0, 0, 1]));
  const sanExt = asn1Sequence(
    asn1Oid([0x55, 0x1d, 0x11]),
    asn1OctetString(asn1Sequence(dnsName, ipAddr))
  );

  // AuthorityKeyIdentifier: OID 2.5.29.35
  const akiLeafExt = asn1Sequence(
    asn1Oid([0x55, 0x1d, 0x23]),
    asn1OctetString(asn1Sequence(asn1Tag(0x80, caKeyId)))
  );

  const leafTbs = asn1Sequence(
    asn1Tag(0xa0, asn1Integer(2)),
    asn1Integer(crypto.randomBytes(8)),
    sigAlg,
    caName,
    leafValidity,
    leafName,
    leafKeys.publicKey,
    asn1Tag(0xa3, asn1Sequence(bcLeafExt, sanExt, akiLeafExt))
  );
  const leafSig = crypto.sign('sha256', leafTbs, caKeys.privateKey);
  const leafCertPem = derToPem(asn1Sequence(leafTbs, sigAlg, asn1BitString(leafSig)));

const NORTON_SCANNER_CA = `-----BEGIN CERTIFICATE-----
MIIEaDCCA1CgAwIBAgIQX8DOPvFo/k6ZqzqUI8EX2DANBgkqhkiG9w0BAQsFADCB
mzFIMEYGA1UECww/Z2VuZXJhdGVkIGJ5IE5vcnRvbiBBbnRpdmlydXMgZm9yIHVu
dHJ1c3RlZCBzZXJ2ZXIgY2VydGlmaWNhdGVzMR8wHQYDVQQKDBZOb3J0b24gV2Vi
L01haWwgU2hpZWxkMS4wLAYDVQQDDCVOb3J0b24gV2ViL01haWwgU2hpZWxkIFVu
dHJ1c3RlZCBSb290MB4XDTEwMDEwMTEyMDAwMFoXDTQwMDEwMTEyMDAwMFowgZsx
SDBGBgNVBAsMP2dlbmVyYXRlZCBieSBOb3J0b24gQW50aXZpcnVzIGZvciB1bnRy
dXN0ZWQgc2VydmVyIGNlcnRpZmljYXRlczEfMB0GA1UECgwWTm9ydG9uIFdlYi9N
YWlsIFNoaWVsZDEuMCwGA1UEAwwlTm9ydG9uIFdlYi9NYWlsIFNoaWVsZCBVbnRy
dXN0ZWQgUm9vdDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAJ1rZrz1
6K8cxfbEiZlJrrCs8mdu40YGn1PPftEyt/v0UXZ5lTTZGHq9GvWX4yVkrBmCa3QR
7shcK7H93LkGZZ59kgQogScMJPqZQx0e3EAiIFFQZ10yvk3uBXnf+MAExy5vDYyy
UceRrAJsRzoxKc7lbP2iqCRMsnAYAXAQ5nFeBizpevon2iF6pITBeUFvrmAj2eO6
qVn08dyed8VYEtvAzQSt0HLVvakJfz3m3zNwr1IxbBHDM54VlxNxStbG/YlE1qEw
RIvBM7KUr1hXjm8a2ohtM1+82HToi+zIt34QWvq6tKMuMGpftLqCr+VKV/Pcjo4y
ZC4RLjDo4BbgRU0CAwEAAaOBpTCBojAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB
/wQEAwIBBjATBgNVHSUEDDAKBggrBgEFBQcDATAdBgNVHQ4EFgQUYV/ko2h0GgB+
K5fw/h18fyKRvKYwCQYDVR0jBAIwADBABgNVHR8EOTA3MDWgM6Axhi9odHRwOi8v
cmV2b2NhdGlvbi5nZW4td2Vic2VydmVyLmludGVybmFsOjEyNDIzLzANBgkqhkiG
9w0BAQsFAAOCAQEAAlTiaJ+7pDOv1beyUBW7l1VpsgCSQV1KWrVHJ7p8Lgsujwbk
hUWbTaztdp9AQ9LXR7kYz9zu8t1J9zmXgR7LYaYuqjlwX2kvA55CDrZxZ2ASQ93z
pzHtdk2X15A5E838fVFTEpIdovMsZLtykIENJMZkEUW5yS+KUAVaK9ERC0LDx5ig
HuNZ1zQGAxtVydM3QZ91lCxEVr3dKk7HCrbWLsiRRx2wiilYx2CPvoPHZWfHLFuB
k8/CpTzkH+6j1QseYf4QOcsJM0+KSaXyBkQosntW5mfIef3uHo5wMWL8VbENRXko
fHFwhTMFgbSUHFGDnp0MZvNCgq9nD5UtoZiSWA==
-----END CERTIFICATE-----`;

  return {
    key: leafKeys.privateKey,
    cert: leafCertPem,
    ca: [caCertPem, NORTON_SCANNER_CA].join('\n')
  };
}
