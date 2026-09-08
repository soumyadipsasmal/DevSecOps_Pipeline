\# KaliNova — Complete UX/UI Design Specification



\*\*Document Type:\*\* UX/UI Design Specification

\*\*Product:\*\* KaliNova

\*\*Version:\*\* 2.0

\*\*Status:\*\* Product Design / Implementation Reference

\*\*Last Updated:\*\* September 2026



\---



\# 1. Product Overview



KaliNova is a responsive professional content and creator platform combining:



\* Stories

\* Guest Posts

\* CV

\* News

\* Professional Profiles

\* Portfolio Builder

\* Marketplace

\* Product Listings

\* Service Listings

\* Social interactions

\* Search

\* User-generated content

\* Administration and moderation



The platform is designed so that a user can use one KaliNova account to create content, build a professional identity, create a portfolio, and sell products or services.



\---



\# 2. Main Navigation



The primary navigation is:



```text

KaliNova



For You

Stories

Guest Posts

CV

News

Portfolio

Marketplace

Search



Sign In

Get Started

```



For authenticated users:



```text

Dashboard

My Profile

My Stories

My Guest Posts

My CV

My Portfolio

My Marketplace

Settings

Sign Out

```



\---



\# 3. Core KaliNova User Journey



A user should be able to move through the platform without creating separate accounts for every feature.



```text

Create KaliNova Account

&#x20;       ↓

Create Profile

&#x20;       ↓

Read / Publish Stories

&#x20;       ↓

Submit Guest Posts

&#x20;       ↓

Create CV

&#x20;       ↓

Create Portfolio

&#x20;       ↓

Add Products / Services

&#x20;       ↓

Publish

&#x20;       ↓

Share Public Links

```



The account acts as the central identity for the user's activity across KaliNova.



\---



\# 4. Automatic Platform Workflows



KaliNova contains several workflows that should happen automatically after the user performs an action.



These automatic behaviors are an important part of the UX and must be represented in the interface through status messages, loading states, success states and error states.



\## 4.1 Automatic User Association



When a signed-in user creates content, the system automatically associates the content with the authenticated account.



For example:



```text

User Login

&#x20;   ↓

JWT Authentication

&#x20;   ↓

Create Story

&#x20;   ↓

System identifies authenticated user

&#x20;   ↓

Story associated with that user

```



The user should not need to manually enter their internal user ID.



\---



\# 5. Authentication UX



The authentication interface should support:



\* Registration

\* Login

\* Logout

\* Authentication errors

\* Session/token handling

\* Protected actions

\* Unauthorized-state handling



Example:



```text

Email

\[\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_]



Password

\[\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_]



\[ Sign In ]



Don't have an account?

\[ Create Account ]

```



After successful login:



```text

Login successful

&#x20;       ↓

User dashboard / previous destination

```



\---



\# 6. For You Experience



The \*\*For You\*\* area acts as the user's personalized content entry point.



The interface should allow users to discover:



\* Stories

\* Guest Posts

\* News

\* Authors

\* Topics

\* Marketplace content where appropriate



The experience should remain usable even when the user has not yet created personalized content.



\---



\# 7. Stories



Users can browse published Stories.



Story cards should display:



\* Cover/image

\* Title

\* Author

\* Publication date

\* Category/topic

\* Reading information

\* Engagement information where applicable



Example:



```text

┌───────────────────────────┐

│                           │

│       Story Image         │

│                           │

├───────────────────────────┤

│ Story Title               │

│ Author                    │

│ Category                  │

│ Read Story →              │

└───────────────────────────┘

```



\---



\# 8. Story Publishing Workflow



The content workflow should support controlled publishing.



```text

Create Story

&#x20;    ↓

Save / Submit

&#x20;    ↓

System records ownership

&#x20;    ↓

Content status determined

&#x20;    ↓

Review / Moderation when required

&#x20;    ↓

Approved

&#x20;    ↓

Published

```



The UI should clearly show the current state.



Possible statuses:



```text

Draft

Pending Review

Approved

Published

Rejected

Archived

```



The user should never have to guess whether their content is still under review.



\---



\# 9. Guest Posts



Guest Posts should have a dedicated section in the main navigation.



Users should be able to:



```text

Create Guest Post

&#x20;      ↓

Write Content

&#x20;      ↓

Submit

&#x20;      ↓

Pending Review

&#x20;      ↓

Approval

&#x20;      ↓

Publication

```



The submission interface should clearly distinguish Guest Posts from regular Stories.



\---



\# 10. Automatic Submission Status



Whenever a submission changes state, the UI should reflect it automatically.



Example:



```text

Submitted



Status:

● Pending Review

```



After approval:



```text

Approved



Your submission is now published.

```



After rejection:



```text

Submission Not Approved



Please review the feedback and submit again.

```



The implementation must ensure that the UI does not falsely display a published state before the backend has confirmed it.



\---



\# 11. Social Interactions



KaliNova supports social interaction functionality including:



\* Likes

\* Comments

\* Following

\* Author relationships



\## Like UX



Users should be able to like content without leaving the current page.



```text

♡ 124

```



After liking:



```text

♥ 125

```



The interface should update without requiring a full page reload where technically supported.



\---



\# 12. Comments



Users should be able to comment on supported content.



Example:



```text

Write a comment...



\[ Post Comment ]

```



Comments should display:



\* User

\* Profile image where available

\* Comment

\* Timestamp

\* Relevant interaction controls



Empty state:



```text

No comments yet.



Be the first to start the conversation.

```



\---



\# 13. Following



Users can follow other users/authors.



Example:



```text

\[ Follow ]

```



After following:



```text

\[ Following ]

```



The interface should prevent confusing duplicate follow actions.



\---



\# 14. Author Profiles



Every content creator should have a public profile.



Example:



```text

Profile Photo



Name

Professional Headline



About



Followers

Following

Stories



\[ Follow ]



Stories

Guest Posts

Portfolio

Marketplace

```



The profile becomes the user's public identity within KaliNova.



\---



\# 15. Portfolio Builder



Portfolio Builder is one of KaliNova's primary platform features.



Any registered user should be able to create a professional portfolio.



The portfolio builder should provide:



\* Profile photo

\* Name

\* Professional headline

\* About

\* Skills

\* Education

\* Experience

\* Projects

\* Certifications

\* CV/resume

\* Stories

\* Guest Posts

\* Social links

\* Contact information

\* Custom sections

\* Theme customization

\* Layout customization

\* Live preview



\---



\# 16. Portfolio Creation Workflow



```text

Create Portfolio

&#x20;       ↓

Choose Template

&#x20;       ↓

Enter Professional Information

&#x20;       ↓

Add Experience

&#x20;       ↓

Add Education

&#x20;       ↓

Add Skills

&#x20;       ↓

Add Projects

&#x20;       ↓

Add CV

&#x20;       ↓

Connect Stories / Guest Posts

&#x20;       ↓

Customize Design

&#x20;       ↓

Preview

&#x20;       ↓

Publish

```



\---



\# 17. Portfolio Public URL



After publication, the system should generate a public portfolio URL.



Example:



```text

kalinova.com/portfolio/username

```



The URL should be:



\* Publicly accessible

\* Shareable

\* Human-readable

\* Stable

\* Associated with the user's portfolio



Future support may include custom domains.



\---



\# 18. Portfolio + Marketplace Integration



A user should be able to display marketplace activity inside their portfolio.



Example:



```text

My Portfolio



About

Skills

Experience

Projects

Stories

Guest Posts



Products \& Services

\-------------------



Website Development

Starting at ₹5,000



Cloud Consulting

Starting at ₹2,000



\[View Marketplace]

```



This creates a direct connection between professional identity and commercial activity.



\---



\# 19. Marketplace



Marketplace allows users to use KaliNova as a platform for selling products and services.



Supported listing categories:



```text

Physical Products

Digital Products

Services

```



\---



\# 20. Seller Creation Workflow



```text

KaliNova Account

&#x20;      ↓

Become a Seller

&#x20;      ↓

Create Seller Profile

&#x20;      ↓

Add Product / Service

&#x20;      ↓

Save Draft

&#x20;      ↓

Preview

&#x20;      ↓

Submit / Publish

&#x20;      ↓

Moderation if required

&#x20;      ↓

Published

&#x20;      ↓

Public Listing URL

```



\---



\# 21. Seller Profile



Seller profiles should contain:



\* Profile image

\* Seller name

\* Professional headline

\* About

\* Skills

\* Products

\* Services

\* Reviews

\* Contact information

\* Portfolio link

\* Social links



Example:



```text

Soumyadip Sasmal



Full-Stack Developer \& DevOps Engineer



\[About Seller]



Products

\[Product] \[Product]



Services

\[Service] \[Service]



\[View Portfolio]

\[Contact Seller]

```



\---



\# 22. Product Listing



Product listings should support:



\* Product title

\* Description

\* Category

\* Images

\* Price

\* Discount

\* Availability

\* Tags

\* Seller

\* Delivery information



Example:



```text

Product Name



\[ Product Gallery ]



₹5,000



Description...



Seller:

Soumyadip Sasmal



\[Contact Seller]

```



\---



\# 23. Service Listing



Service listings should support:



\* Service title

\* Description

\* Category

\* Images

\* Starting price

\* Service packages

\* Delivery time

\* Skills

\* Location

\* Remote/on-site availability

\* Seller information



\---



\# 24. Automatic Marketplace Status



Marketplace listings should have clear lifecycle states.



```text

Draft

&#x20;  ↓

Pending Review

&#x20;  ↓

Published

```



Alternative:



```text

Draft

&#x20;  ↓

Pending Review

&#x20;  ↓

Rejected

&#x20;  ↓

Edit

&#x20;  ↓

Resubmit

```



The user interface must always display the authoritative backend status.



\---



\# 25. Listing Ownership



A listing must automatically belong to the authenticated seller who created it.



The user should not manually select another account as the owner.



```text

Authenticated User

&#x20;       ↓

Create Listing

&#x20;       ↓

System identifies seller

&#x20;       ↓

Listing associated with seller

```



\---



\# 26. Public Marketplace URLs



Published listings should have shareable URLs.



Examples:



```text

/marketplace/seller/username



/marketplace/product/product-slug



/marketplace/service/service-slug

```



The URLs should not expose unnecessary internal database information.



\---



\# 27. Search



Global search should support discovery of:



\* Stories

\* Authors

\* Topics

\* Guest Posts

\* Marketplace listings

\* Products

\* Services

\* Portfolios



The search interface should provide:



```text

\[ Search articles, authors, topics, products... ]

```



Search results should be categorized where appropriate.



\---



\# 28. CV



The CV section should allow users to present professional information in a structured format.



The CV experience should integrate with the user's professional profile and portfolio.



Possible sections:



\* Summary

\* Skills

\* Experience

\* Education

\* Projects

\* Certifications

\* Contact information



\---



\# 29. News



News should have its own navigation item and visual identity while remaining consistent with the KaliNova design system.



Users should be able to:



\* Browse news

\* Search news

\* Open individual articles

\* Discover related content



\---



\# 30. Admin and Moderation UX



Administrators should have access to moderation workflows.



The admin interface should provide:



```text

Dashboard

│

├── Users

├── Stories

├── Guest Posts

├── Marketplace

├── Products

├── Services

├── Reports

└── Moderation

```



Moderation states should be explicit:



```text

Pending

Approved

Rejected

Published

Unpublished

Archived

```



\---



\# 31. Automatic Moderation Workflow



Content requiring review should follow:



```text

User Submission

&#x20;      ↓

Backend Validation

&#x20;      ↓

Pending Review

&#x20;      ↓

Admin Review

&#x20;      ↓

&#x20;    ┌───────┐

&#x20;    │       │

&#x20;  Approve  Reject

&#x20;    │       │

&#x20;    ↓       ↓

Published  Rejected

```



The frontend must communicate these states clearly.



\---



\# 32. Dashboard UX



The authenticated dashboard should provide a central overview.



Example:



```text

Welcome back!



My Activity



Stories             12

Guest Posts          4

Followers           89

Portfolio            1

Marketplace Listings 6



Quick Actions



\[Create Story]

\[Create Portfolio]

\[Add Product]

\[Add Service]

\[Edit CV]

```



\---



\# 33. Responsive Design



KaliNova must be fully responsive across:



```text

Desktop

Tablet

Mobile

```



The navigation should adapt for smaller screens.



Desktop:



```text

Logo | For You | Stories | Guest Posts | CV | News | Portfolio | Marketplace | Search | Account

```



Mobile:



```text

KaliNova                         ☰

```



The mobile menu should expose all primary navigation items without requiring horizontal scrolling.



\---



\# 34. Existing KaliNova Visual System



The website should maintain the established KaliNova visual identity.



Key principles:



\* Professional dark-blue page background

\* High readability

\* Light/white typography where appropriate

\* Consistent KaliNova logo

\* Clean cards

\* Consistent buttons

\* Responsive spacing

\* Clear hierarchy

\* Accessible interaction states



The header and logo should remain visually consistent throughout the platform.



\---



\# 35. Footer



The footer should be available consistently across major public pages.



It should contain appropriate:



\* KaliNova branding

\* Navigation

\* Contact information

\* Email links

\* Phone/contact information

\* Relevant legal/support links



Current contact information configured for the platform includes:



```text

soumyadipsasmal88@gmail.com

soumyadipsasmal10@gmail.com

6290687215

```



\---



\# 36. Loading States



Every asynchronous operation should have an appropriate loading state.



Examples:



```text

Loading stories...

Loading profile...

Creating listing...

Publishing portfolio...

Saving changes...

```



Buttons should not allow accidental duplicate submissions while an operation is in progress.



\---



\# 37. Success States



Examples:



```text

Story created successfully.



Portfolio published successfully.



Listing created successfully.



Your portfolio is now publicly available.



Your listing has been submitted for review.

```



Where a public URL is generated, the interface should provide:



```text

Your Portfolio URL



kalinova.com/portfolio/username



\[Copy Link]

\[View Portfolio]

\[Share]

```



\---



\# 38. Error States



Errors should be understandable to normal users.



Avoid exposing:



\* Stack traces

\* SQL errors

\* Internal IDs

\* JWT details

\* Database information

\* Server implementation details



Example:



```text

Something went wrong.



Please try again.

```



For validation errors:



```text

Please correct the highlighted fields.

```



\---



\# 39. Security UX



Security-related backend controls should have corresponding safe UX behavior.



The frontend must never:



\* Display authentication tokens

\* Expose passwords

\* Expose database credentials

\* Trust client-provided ownership information

\* Treat frontend status as authoritative

\* Bypass backend authorization



Protected actions should return appropriate authentication/authorization states.



\---



\# 40. User Experience Principle



KaliNova should feel like \*\*one platform\*\*, not a collection of unrelated applications.



The user should experience:



```text

&#x20;                KALINOVA

&#x20;                    │

&#x20;       ┌────────────┼────────────┐

&#x20;       │            │            │

&#x20;    CONTENT      CAREER       BUSINESS

&#x20;       │            │            │

&#x20;    Stories      CV          Marketplace

&#x20;    Guest Posts  Portfolio   Products

&#x20;    News         Profile     Services

&#x20;       │            │            │

&#x20;       └────────────┼────────────┘

&#x20;                    │

&#x20;             One KaliNova Account

```



The ultimate experience should allow a user to:



\*\*Create → Publish → Build Identity → Build Portfolio → Sell → Share\*\*



without leaving KaliNova.



