const DOMAIN_SUFFIXES = ['org', 'com', 'es', 'net', 'cat', 'eu', 'coop'];

const repairMissingDomainDots = (hostname: string): string => {
    const compactMatch = hostname.match(/^www\.?(.+?)(org|com|es|net|cat|eu|coop)$/i);
    if (!compactMatch) return hostname;
    return `www.${compactMatch[1]}.${compactMatch[2]}`;
};

export const normalizarUrl = (raw: string | undefined): string | undefined => {
    let value = raw?.replace(/\s+/g, '').trim();
    if (!value) return undefined;

    while (/^https?:\/\/https?:\/\//i.test(value)) {
        value = value.replace(/^https?:\/\//i, '');
    }
    if (!/^https?:\/\//i.test(value)) value = `https://${value}`;

    try {
        const url = new URL(value);
        const repairedHostname = repairMissingDomainDots(url.hostname).replace(/\.{2,}/g, '.');
        if (!repairedHostname.includes('.') || !DOMAIN_SUFFIXES.some((suffix) => repairedHostname.endsWith(`.${suffix}`))) {
            return undefined;
        }
        url.hostname = repairedHostname;
        return url.toString();
    } catch {
        return undefined;
    }
};
