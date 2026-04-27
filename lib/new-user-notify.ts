import { Users } from "@prisma/client";

import { prismadb } from "./prisma";
import resendHelper from "./resend";

export async function newUserNotify(newUser: Users) {
  const admins = await prismadb.users.findMany({
    where: {
      role: "admin",
    },
  });

  const resend = await resendHelper();

  admins.forEach(async (admin) => {
    try {
      await resend.emails.send({
        from: `${process.env.NEXT_PUBLIC_APP_NAME} <${process.env.EMAIL_FROM}>`,
        to: admin.email,
        subject: `New User Registration with PENDING state`,
        text: `New User Registered: ${newUser.name} \n\n Please login to ${process.env.NEXT_PUBLIC_APP_URL}/admin/users and activate them. \n\n Thank you \n\n ${process.env.NEXT_PUBLIC_APP_NAME}`,
      });

      console.log("Email sent to admin");
    } catch (error) {
      console.error("Failed to send admin notification email:", error);
    }
  });
}
