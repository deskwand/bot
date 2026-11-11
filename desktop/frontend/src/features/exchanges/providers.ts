export type ExchangeVenueId = "okx" | "binance";

export type ExchangeVenueOption = {
  id: ExchangeVenueId;
  name: string;
  /** Secret fields this venue needs, in display order. */
  fields: readonly ("key" | "secret" | "passphrase")[];
  defaultBaseUrl: string;
  signupUrl: string;
  permissions: string;
};

export const EXCHANGE_VENUES: readonly ExchangeVenueOption[] = [
  {
    id: "okx",
    name: "OKX",
    fields: ["key", "secret", "passphrase"],
    defaultBaseUrl: "https://www.okx.com",
    signupUrl: "https://www.okx.com/account/my-api",
    permissions: "Read",
  },
  {
    id: "binance",
    name: "Binance",
    fields: ["key", "secret"],
    defaultBaseUrl: "https://api.binance.com",
    signupUrl: "https://www.binance.com/en/my/settings/api-management",
    permissions: "Enable Reading",
  },
];

export function venueOption(id: string): ExchangeVenueOption | undefined {
  return EXCHANGE_VENUES.find((venue) => venue.id === id);
}

/** `EXCHANGE_SECRET_<ID>`: mirrors src/exchange/accounts.ts. */
export function exchangeSecretName(id: string): string {
  return `EXCHANGE_SECRET_${id.toUpperCase().replaceAll("-", "_")}`;
}
