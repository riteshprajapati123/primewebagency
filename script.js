/* =================================
   TYPING ANIMATION
================================= */

const typingElement = document.getElementById("typing");

const words = [
    "Web Developer",
    "Website Designer",
    "Frontend Developer",
    "Creative Developer"
];

let wordIndex = 0;
let charIndex = 0;
let deleting = false;


function typeEffect() {

    const currentWord = words[wordIndex];

    if (!deleting) {

        typingElement.textContent =
            currentWord.substring(0, charIndex + 1);

        charIndex++;

        if (charIndex === currentWord.length) {

            deleting = true;

            setTimeout(typeEffect, 1500);

            return;
        }

    } else {

        typingElement.textContent =
            currentWord.substring(0, charIndex - 1);

        charIndex--;

        if (charIndex === 0) {

            deleting = false;

            wordIndex++;

            if (wordIndex >= words.length) {
                wordIndex = 0;
            }

        }

    }

    const speed = deleting ? 60 : 100;

    setTimeout(typeEffect, speed);
}

typeEffect();



/* =================================
   MOBILE MENU
================================= */

const menuBtn = document.getElementById("menuBtn");
const navMenu = document.getElementById("navMenu");

menuBtn.addEventListener("click", () => {

    navMenu.classList.toggle("active");

});


/* Close menu after clicking a link */

const navLinks = document.querySelectorAll("#navMenu a");

navLinks.forEach(link => {

    link.addEventListener("click", () => {

        navMenu.classList.remove("active");

    });

});



/* =================================
   SCROLL REVEAL ANIMATION
================================= */

const revealElements =
    document.querySelectorAll(".reveal");


function revealOnScroll() {

    const windowHeight = window.innerHeight;

    revealElements.forEach(element => {

        const elementTop =
            element.getBoundingClientRect().top;

        if (elementTop < windowHeight - 100) {

            element.classList.add("active");

        }

    });

}


window.addEventListener(
    "scroll",
    revealOnScroll
);

revealOnScroll();



/* =================================
   NAVBAR SCROLL EFFECT
================================= */

const navbar =
    document.querySelector(".navbar");


window.addEventListener("scroll", () => {

    if (window.scrollY > 50) {

        navbar.style.background =
            "rgba(5, 9, 17, 0.92)";

    } else {

        navbar.style.background =
            "rgba(7, 11, 20, 0.65)";

    }

});



/* =================================
   BUTTON RIPPLE EFFECT
================================= */

const buttons =
    document.querySelectorAll(".btn, .contact-btn");


buttons.forEach(button => {

    button.addEventListener("click", function () {

        this.style.transform = "scale(0.97)";

        setTimeout(() => {

            this.style.transform = "";

        }, 120);

    });

});



/* =================================
   CURRENT YEAR
================================= */

const footerYear =
    document.querySelector("footer");

if (footerYear) {

    footerYear.innerHTML =
        footerYear.innerHTML.replace(
            "2026",
            new Date().getFullYear()
        );

}