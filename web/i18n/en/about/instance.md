<script lang="ts">
    import { t } from "$lib/i18n/translations";
    import SectionHeading from "$components/misc/SectionHeading.svelte";
</script>

<section id="about">
<SectionHeading
    title={$t("about.heading.instance_about")}
    sectionId="about"
/>

this cobalt instances is hosted by the [canine.tools project](https://canine.tools/).
</section>

<section id="services">
<SectionHeading
    title={$t("about.heading.instance_services")}
    sectionId="services"
/>

we use a vpn for all outbound requests.

we like to thank the users below for helping contribute patches and fixes we use in our fork:
* [patrick](https://patriick.dev/)
* [br0k3x](https://br0k3.me/)

</section>

<section id="fork">
<SectionHeading
    title={$t("about.heading.instance_fork")}
    sectionId="fork"
/>

our instance (web and api) is running a fork of the main cobalt codebase. it's licensed under the same license. you can find all changes on [our repository](https://git.canine.tools/canine.tools/cobalt).

* [api license](https://git.canine.tools/canine.tools/cobalt/src/branch/main/api#license)
* [web license](https://git.canine.tools/canine.tools/cobalt/src/branch/main/web#license)

</section>