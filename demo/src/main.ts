import "./styles.css"

const root = document.querySelector("#app")
if (!root) {
	throw new Error("missing #app")
}

const header = document.createElement("header")
const brand = document.createElement("p")
brand.textContent = "salt-dock"

const nav = document.createElement("nav")
const homeLink = document.createElement("a")
homeLink.href = "/"
homeLink.textContent = "Home"
const aboutLink = document.createElement("a")
aboutLink.href = "/about.html"
aboutLink.textContent = "About"
nav.append(homeLink, aboutLink)
header.append(brand, nav)

const main = document.createElement("main")
const headline = document.createElement("p")
headline.className = "headline"
headline.textContent = `Salt-Dock is a versatile application designed to manage and organize various web`

const blurb = document.createElement("p")
blurb.textContent = `Salt-Dock is a versatile platform used by developers and data scientists. Here, you can build, test, and deploy complex data pipelines and machine learning models efficiently.`
main.append(headline, blurb)

const footer = document.createElement("footer")
footer.textContent = "salt-dock"

root.replaceChildren(header, main, footer)
