import { OverseerrClient } from "./overseerr-client-generated";

export const overseerrClient = new OverseerrClient({
    BASE: process.env.OVERSEERR_BASE_URL!,
    TOKEN: process.env.OVERSEERR_TOKEN!,
})
