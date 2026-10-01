import "./styles.css"

const root = document.querySelector("#app")
if (!root) {
	throw new Error("missing #app")
}

const header = document.createElement("header")
const kicker = document.createElement("p")
kicker.textContent = "Page"
const nav = document.createElement("nav")
const homeLink = document.createElement("a")
homeLink.href = "/"
homeLink.textContent = "Home"
nav.append(homeLink)
header.append(kicker, nav)

const main = document.createElement("main")
const heading = document.createElement("h1")
heading.textContent = "About salt-dock"
const article = document.createElement("p")
article.textContent = `Salt-Dock is a community-driven project dedicated to exploring the intersection of digital art and sustainable practices. We believe that technology should not only push creative boundaries but also foster a healthier relationship with our environment. Our mission is to provide a platform where artists, developers, and environmental advocates can collaborate on projects that are both aesthetically`
main.append(heading, article)

const footer = document.createElement("footer")
const back = document.createElement("a")
back.href = "/"
back.textContent = "Back"
footer.append(back)

root.replaceChildren(header, main, footer)
