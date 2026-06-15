import { Hono } from "hono"
import { getVerifiedList } from "../lib/load-data"

/**
 * Route for the verified-community-catalogs list.
 *
 *   GET /v1/verified  - the list of trusted community catalog URLs
 *
 * This endpoint returns URLs, not catalogs. Consumers (the landing app,
 * the baka CLI) fetch each URL themselves, or pass the list to
 * `POST /v1/aggregate` for server-side merging.
 *
 * Cache-control: 1h.
 */

const route = new Hono()

route.get("/v1/verified", (c) => {
	const list = getVerifiedList()
	c.header("Cache-Control", "public, max-age=3600")
	return c.json(list)
})

export default route
